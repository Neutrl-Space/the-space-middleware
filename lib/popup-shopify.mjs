import { ReservationError } from './popup-reservations.mjs';
const soldOut = () => new ReservationError(409, 'VARIANT_SOLD_OUT', 'This size has just sold out.');

export function createPopupShopify(graphql) {
  return {
    async validateVariant(input) {
      const data = await graphql(`query PopupVariant($id: ID!) {
        productVariant(id: $id) {
          id title inventoryPolicy inventoryQuantity
          product { id title status }
          inventoryItem { tracked }
        }
      }`, {id: `gid://shopify/ProductVariant/${input.variantId}`});
      const variant = data.productVariant;
      if (!variant || variant.product.id !== `gid://shopify/Product/${input.productId}` || variant.product.status !== 'ACTIVE') {
        throw new ReservationError(400, 'INVALID_VARIANT', 'This product or size is not available for reservations.');
      }
      // CONTINUE permits overselling even with DECREMENT_OBEYING_POLICY.
      if (!variant.inventoryItem.tracked || variant.inventoryPolicy !== 'DENY') {
        throw new ReservationError(503, 'INVENTORY_CONFIGURATION_REQUIRED', 'Reservations for this piece are not open yet.');
      }
      if (variant.inventoryQuantity < input.quantity) throw soldOut();
      return variant;
    },
    async createOrder(input) {
      const data = await graphql(`mutation CreatePopupOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput!) {
        orderCreate(order: $order, options: $options) {
          order { id name }
          userErrors { code field message }
        }
      }`, {
        order: {
          financialStatus: 'PENDING',
          lineItems: [{variantId: `gid://shopify/ProductVariant/${input.variantId}`, quantity: input.quantity}],
          ...(input.email ? {email: input.email} : {}),
          phone: input.phone,
          note: `SoHo pop-up reservation ${input.reservationCode} for ${input.name}. Pay In Store. Payment due at collection.`,
          tags: ['SOHO_POPUP', 'QR_RESERVATION', `popup-request-${input.requestId}`],
          sourceIdentifier: input.requestId,
          customAttributes: [
            {key: 'reservation_code', value: input.reservationCode},
            {key: 'external_payment_method', value: 'Pay In Store'},
            {key: 'reservation_request_id', value: input.requestId},
            {key: 'reservation_name', value: input.name},
            {key: 'source', value: 'soho-popup-qr'},
          ],
        },
        options: {inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: false, sendFulfillmentReceipt: false},
      });
      const result = data.orderCreate;
      if (!result.order && result.userErrors.some((error) => error.code === 'INVENTORY_CLAIM_FAILED')) throw soldOut();
      if (result.userErrors.length || !result.order?.id) throw new Error('Order creation outcome requires review');
      return result.order;
    },
    async verifyOrder(orderId, input) {
      const data = await graphql(`query VerifyPopupOrder($id: ID!) {
        order(id: $id) {
          id cancelledAt displayFinancialStatus
          lineItems(first: 2) {
            nodes {
              quantity unfulfilledQuantity
              variant {
                id inventoryPolicy
                inventoryItem {
                  tracked
                  inventoryLevels(first: 100) {
                    nodes { quantities(names: ["committed"]) { name quantity } }
                    pageInfo { hasNextPage }
                  }
                }
              }
            }
          }
        }
      }`, {id: orderId});
      const order = data.order, lines = order?.lineItems.nodes || [], line = lines[0];
      if (!order || order.cancelledAt || order.displayFinancialStatus !== 'PENDING' || lines.length !== 1 ||
          line.variant?.id !== `gid://shopify/ProductVariant/${input.variantId}` ||
          line.quantity !== input.quantity || line.unfulfilledQuantity !== input.quantity ||
          !line.variant.inventoryItem.tracked || line.variant.inventoryPolicy !== 'DENY') {
        throw new Error('Order verification failed');
      }
      const levels = line.variant.inventoryItem.inventoryLevels;
      const committed = levels.nodes.reduce((sum, level) => sum + (level.quantities.find((q) => q.name === 'committed')?.quantity || 0), 0);
      if (committed < input.quantity) throw new Error('Inventory commitment not confirmed');
      // The atomic orderCreate claim is authoritative; this readback is supporting evidence,
      // not a global before/after delta that could race with unrelated orders.
      return {orderId, variantId: input.variantId, quantity: input.quantity, committed, checkedAt: new Date().toISOString(), inventoryBehaviour: 'DECREMENT_OBEYING_POLICY'};
    },
  };
}
