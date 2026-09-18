import supabase from '../../lib/supabase';
import { shopifyGraphql } from '../../lib/shopify';
import { createReservationService, ReservationError } from '../../lib/popup-reservations.mjs';
import { createPopupShopify } from '../../lib/popup-shopify.mjs';
import { createPopupStore } from '../../lib/popup-store.mjs';

const reserve = createReservationService({
  store: createPopupStore(supabase),
  shopify: createPopupShopify(shopifyGraphql),
});

async function readBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new ReservationError(415, 'INVALID_CONTENT_TYPE', 'Send JSON reservation details.');
  }
  let body = req.body;
  if (body === undefined) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += Buffer.byteLength(chunk);
      if (length > 8192) throw new ReservationError(413, 'REQUEST_TOO_LARGE', 'Reservation details are too large.');
      chunks.push(Buffer.from(chunk));
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body)) > 8192) {
    throw new ReservationError(413, 'REQUEST_TOO_LARGE', 'Reservation details are too large.');
  }
  if (typeof body === 'string') {
    try { return JSON.parse(body); }
    catch { throw new ReservationError(400, 'INVALID_JSON', 'Invalid JSON.'); }
  }
  return body;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  const origins = (process.env.POPUP_ALLOWED_ORIGINS || 'https://neutrlspace.com,https://www.neutrlspace.com').split(',').map((origin) => origin.trim());
  const origin = req.headers.origin;
  if (origin && !origins.includes(origin)) return res.status(403).json({success: false, code: 'ORIGIN_NOT_ALLOWED', message: 'This storefront is not allowed.'});
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({success: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.'});
  }
  if (process.env.POPUP_RESERVATIONS_ENABLED !== 'true') {
    return res.status(503).json({success: false, code: 'RESERVATIONS_CLOSED', message: 'Reservations are not open yet.'});
  }
  try {
    const result = await reserve(await readBody(req));
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof ReservationError) return res.status(error.status).json({success: false, code: error.code, message: error.message});
    console.error('popup_endpoint_failed');
    return res.status(503).json({success: false, code: 'RESERVATION_UNAVAILABLE', message: 'We could not confirm this request. Please retry with the same request ID.'});
  }
}
