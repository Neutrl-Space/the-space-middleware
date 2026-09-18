import { createHash } from 'node:crypto';

export const CONSENT_TEXT = 'I agree to receive SMS updates about this reservation.';
export class ReservationError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (message) => { throw new ReservationError(400, 'INVALID_REQUEST', message); };
export function validateReservation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('A JSON object is required.');
  const id = (value) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('Invalid Shopify ID.');
    if (!/^[1-9]\d{0,19}$/.test(String(value ?? ''))) fail('Invalid Shopify ID.');
    return String(value);
  };
  const text = (value, max, required = false) => {
    if (value !== undefined && typeof value !== 'string') fail('Invalid customer details.');
    const result = (value || '').trim();
    if ((required && !result) || result.length > max || /[\x00-\x1f]/.test(result)) fail('Invalid customer details.');
    return result;
  };
  const productId = id(body.productId), variantId = id(body.variantId);
  if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 2) fail('Quantity must be 1 or 2.');
  const name = text(body.name, 150, true);
  const phone = text(body.phone, 40, true).replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) fail('Enter your phone number with country code, for example +12125551234.');
  const email = text(body.email, 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.');
  if (body.smsConsent !== true) fail('SMS consent is required.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId || '')) fail('A valid request ID is required.');
  if (body.source !== 'soho-popup-qr') fail('Invalid reservation source.');
  return {productId, variantId, quantity: body.quantity, name, phone, email, smsConsent: true, source: body.source, requestId: body.requestId.toLowerCase()};
}
const reply = (status, code, message) => ({status, body: {success: false, code, message}});
const pending = () => reply(202, 'RESERVATION_REVIEW_REQUIRED', 'Your reservation needs confirmation. Please contact us before submitting another request.');

// Dependencies are injected so concurrency and failure paths can be tested without live orders or SMS.
export function createReservationService({store, shopify, sendSms = null, logger = console}) {
  return async function reserve(body) {
    const input = validateReservation(body);
    const {requestId, ...details} = input;
    const fingerprint = createHash('sha256').update(JSON.stringify(details)).digest('hex');
    const claim = await store.claim(input, fingerprint);
    if (!claim.owner) {
      if (claim.record.fingerprint !== fingerprint) return reply(409, 'REQUEST_ID_REUSED', 'This request ID was already used for different details.');
      return claim.record.response || pending();
    }
    let stage = 'validate_inventory';
    let order;
    try {
      const variant = await shopify.validateVariant(input);
      const reservationCode = claim.record.reservation_code;
      if (!/^NS-\d{4,}$/.test(reservationCode || '')) throw new Error('Reservation code was not allocated');
      stage = 'create_order';
      order = await shopify.createOrder({...input, reservationCode});
      // Persist the order ID before additional network operations.
      await store.updateRequest(requestId, {shopify_order_id: order.id, status: 'order_created'});
      stage = 'verify_inventory';
      const evidence = await shopify.verifyOrder(order.id, input);
      stage = 'record_event';
      const event = {
        shopify_order_id: order.id,
        reservation_code: reservationCode,
        shopify_order_name: order.name,
        product_id: input.productId,
        variant_id: input.variantId,
        product_title: variant.product.title,
        variant_title: variant.title,
        quantity: input.quantity,
        customer_name: input.name,
        phone: input.phone,
        email: input.email || null,
        sms_consent: true,
        status: 'received',
        confirmation_sms_sent_at: null,
        ready_at: null,
        expires_at: null,
        paid_at: null,
        collected_at: null,
        cancelled_at: null,
      };
      await store.createEvent(event);
      const response = {status: 201, body: {
        success: true, reservationCode, reservationNumber: reservationCode,
        shopifyOrderName: order.name, status: 'received', smsStatus: sendSms ? 'pending' : 'deferred',
      }};
      await store.updateRequest(requestId, {
        status: 'confirmed', response, inventory_evidence: evidence,
        sms_consent_text: CONSENT_TEXT, sms_consent_at: claim.record.created_at,
        sms_status: response.body.smsStatus,
      });
      // Provider selection is pending. Accept the reservation without pretending an SMS was sent.
      if (!sendSms) return response;
      // A messaging failure must never undo a confirmed order or encourage a second order.
      let smsStatus = 'failed';
      let smsId = null;
      try {
        const result = await sendSms({phone: input.phone, reservationNumber: reservationCode});
        smsStatus = 'accepted'; smsId = result.id;
      } catch {
        logger.error('popup_sms_failed', {requestId});
      }
      response.body.smsStatus = smsStatus;
      try {
        await store.updateRequest(requestId, {response, sms_status: smsStatus, sms_provider_id: smsId});
      } catch {
        logger.error('popup_sms_status_save_failed', {requestId});
      }
      return response;
    } catch (error) {
      // Only explicit validation/inventory rejections without an order are safe terminal failures.
      if (error instanceof ReservationError && !order) {
        const response = reply(error.status, error.code, error.message);
        await store.updateRequest(requestId, {status: 'rejected', response});
        return response;
      }
      logger.error('popup_reservation_review_required', {requestId, stage, orderId: order?.id});
      const response = pending();
      try {
        await store.updateRequest(requestId, {status: 'review_required', review_stage: stage, response, ...(order ? {shopify_order_id: order.id} : {})});
      } catch {
        // The initial durable claim still prevents retries from creating another order.
        logger.error('popup_review_save_failed', {requestId});
      }
      return response;
    }
  };
}
