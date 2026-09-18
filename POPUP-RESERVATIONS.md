# SoHo pop-up reservations

`POST /api/popup/reservations` validates the selected Shopify variant and stock, creates an unpaid Shopify order, verifies inventory commitment, and writes the event workflow record to **`event_orders`**. Shopify owns product inventory and the official order; Supabase owns event workflow and reporting.

## Current setup status

- **3.5 — Main Supabase table: completed by you.** The backend now matches the `event_orders` definition you supplied. Do not recreate it or create a second main reservation table.
- **Supporting migration: still required for this implementation.** Run the updated `supabase/popup_reservations.sql` once before enabling reservations. It preserves `event_orders`, adds/updates the internal `popup_reservation_requests` retry ledger, allocates unique `NS-0001` style codes through a database sequence, and restricts both tables to backend service-role access. It also supports an existing request ledger from the earlier implementation. The SQL has been prepared locally, not applied to your remote database.
- **SMS provider: undecided (Shopify Flow or Twilio).** The endpoint does not currently send SMS or require Twilio credentials. It returns `smsStatus: "deferred"`. The existing Twilio adapter is dormant; no Flow integration is wired yet. Select and connect the Ready-message workflow before launching the experience promised by the confirmation screen.
- **Mark Ready and collection workflow: not implemented by this endpoint.** Creating a reservation never starts the 15-minute collection window.

If an earlier `popup_reservations` table was created, the new code no longer writes to it. This migration leaves it untouched. Any historical rows need a separate, reviewed migration if they should appear in `event_orders`.

## Remaining configuration

1. Apply the supporting SQL above to the same Supabase project as `event_orders`.
2. Keep the existing `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and Shopify OAuth configuration. The app needs `read_products`, `read_inventory`, `read_orders`, and `write_orders`. Reauthorize via `/api/auth/shopify` after changing scopes. The implementation supports the existing API version `2026-01`.
3. Enable inventory tracking and disable **Continue selling when out of stock** for reservable variants. The endpoint rejects untracked variants and `CONTINUE` policies. Shopify's existing inventory locations and routing apply; this does not allocate an exclusive SoHo location.
4. Set `POPUP_ALLOWED_ORIGINS` to comma-separated storefront origins, including any preview origin needed for testing. Default: `https://neutrlspace.com,https://www.neutrlspace.com`.
5. Deploy the middleware and set `POPUP_RESERVATIONS_ENABLED=true` when ready for reservation testing. This flag is independent of the theme's Event Mode checkbox. Set **Pop-up Settings → Reservation middleware URL** if different from `https://the-space-middleware.vercel.app`.
6. Finish the selected SMS provider and staff **Mark Ready** workflow before customer launch. Twilio configuration is not a prerequisite for testing reservation creation.

Credentials stay on the backend. These source changes do not modify `.env`, deploy services, apply SQL remotely, create live orders, or send texts.

## Reservation identifiers and Shopify metadata

Each request receives one database-allocated code, for example `NS-0247`, reused for Shopify metadata, `event_orders.reservation_code`, and the confirmation screen. The sequence continues beyond existing `NS-…` codes and supports more than four digits. Rejected attempts can leave gaps; codes are identifiers, not an order count.

Shopify order metadata includes:

- Tags `SOHO_POPUP`, `QR_RESERVATION`, and `popup-request-<requestId>`.
- Additional details: `reservation_code`, `reservation_request_id`, `reservation_name`, `source: soho-popup-qr`, and `external_payment_method: Pay In Store`.
- A note identifying the reservation code and Pay In Store collection arrangement.
- `financialStatus: PENDING`, with no payment transaction or fulfillment created.

**Pay In Store is recorded as order metadata**, not as a successful payment or a configured Shopify payment gateway. Payment is recorded later when the customer pays. The Shopify order's original name (for example `#1001`) is retained in `event_orders.shopify_order_name`; it is separate from `NS-0247`.

## Event record and confirmation screen

A successful submission creates an `event_orders` row with `status: received`, the product/variant IDs and titles, quantity, customer details, and SMS consent. These timestamps remain `null`:

- `confirmation_sms_sent_at`
- `ready_at` and `expires_at`
- `paid_at`, `collected_at`, and `cancelled_at`

The screen shows:

> **RESERVATION NS-0247 RECEIVED**
>
> We’ll prepare your order and text you when it is ready.
>
> After receiving the Ready message, you’ll have 15 minutes to pay and collect your order at the pop-up.

There is no countdown on submission. The future staff **Mark Ready** action must set `ready_at`, set `expires_at` to 15 minutes after readiness, and trigger the Ready notification. Opening the dialog, submitting, retrying, or receiving a confirmation must not start or reset that window. `confirmation_sms_sent_at` should be populated only by the chosen messaging integration when it has evidence of sending; provider acceptance alone is not delivery confirmation.

## Request and response contract

Send numeric Shopify IDs as strings, integer quantity (1–2), name, an international phone number including `+` and country code, optional email, `smsConsent: true`, `source: "soho-popup-qr"`, and a UUID v4 `requestId`.

Success (`201`):

```json
{
  "success": true,
  "reservationCode": "NS-0247",
  "reservationNumber": "NS-0247",
  "shopifyOrderName": "#1001",
  "status": "received",
  "smsStatus": "deferred"
}
```

`reservationNumber` is a compatibility alias for `reservationCode`.

- `409`, `VARIANT_SOLD_OUT`: “This size has just sold out.” The form becomes a Becoming Access link.
- `202`, `RESERVATION_REVIEW_REQUIRED`: an ambiguous or partial outcome needs staff review. This is not a success confirmation.
- `400`: invalid customer details, product/variant relationship, or consent.
- `503`: reservations disabled, inventory configuration missing, or storage unavailable.

## Concurrency and recovery

The inventory read is informational; the Shopify mutation claims stock using `DECREMENT_OBEYING_POLICY` with tracked/DENY variants. `INVENTORY_CLAIM_FAILED` becomes the sold-out conflict. The subsequent order and committed-stock readback provides verification evidence.

`popup_reservation_requests` is an internal retry ledger, not a second event workflow table. It claims a request ID before Shopify side effects and records its code, order ID, response, consent audit, and inventory evidence. `event_orders` is written after inventory verification. Replaying identical details with the same request ID reuses the response and code rather than creating a second order. The browser stores only a payload hash and random request ID in session storage.

If order creation has an unknown outcome, verification fails, or persistence fails after order creation, the durable claim prevents blind retries. Inspect `review_required` requests and stale `processing`/`order_created` requests. Search Shopify by `popup-request-<requestId>`, the reservation code in Additional details, or the stored order ID. Reconcile the order and `event_orders` record before resolving the saved response. Do not delete claims merely to retry. The helper status `confirmed` means reservation creation completed; the event workflow still starts at `received`.

Order pricing follows the Shopify variant. `orderCreate` does not run storefront checkout tax/shipping calculation; staff must finalize applicable amounts at collection. Reservation SMS consent does not subscribe customers to marketing.

## Sync Shopify cancellations to Supabase

The new `POST /api/popup/order-cancelled` endpoint receives Shopify's `orders/cancelled` webhook. It matches `event_orders.shopify_order_id` and sets `status: cancelled`, `cancelled_at` from Shopify, and `updated_at`. Payment, collection and readiness timestamps are preserved as history. Duplicate deliveries do not change the record again.

This updates Supabase only. Cancel the order in Shopify with **Restock inventory** selected to return stock; the webhook never adjusts inventory a second time. It works even when `POPUP_RESERVATIONS_ENABLED=false`, so closing reservations does not stop cancellation synchronization. No new SQL migration is required.

To enable it after deploying the middleware:

1. In Shopify Admin, open **Settings → Notifications → Webhooks → Create webhook**.
2. Select **Order cancellation**, **JSON**, API version **2026-01**, and this URL:
   `https://the-space-middleware.vercel.app/api/popup/order-cancelled`
3. For a webhook created in Shopify Admin, set `SHOPIFY_WEBHOOK_SECRET` in the middleware's Vercel environment to the webhook signing secret shown by Shopify. This is different from the app's client secret; do not replace `SHOPIFY_CLIENT_SECRET`. Redeploy after setting the variable. Keep the secret out of the theme and Git.
4. Ensure the existing `SHOPIFY_SHOP` identifies this store's permanent `.myshopify.com` domain (the store prefix is also supported).
5. Cancel a real test reservation, then verify its matching `event_orders` row becomes `cancelled` and that Shopify restores the variant's available stock when restocking was selected.

If the subscription is instead created through the existing app's API, omit `SHOPIFY_WEBHOOK_SECRET` and the handler uses `SHOPIFY_CLIENT_SECRET` for the app-signed delivery. Choose one registration method for this endpoint.

The handler verifies HMAC against the original request bytes, checks the store and topic, and rejects invalid signatures before database access. Database failures and pop-up cancellations arriving before the reservation row exists return a retryable error. Missing unrelated orders are acknowledged without creating event records. Monitor repeated `popup_cancellation_record_missing` / `popup_cancellation_sync_failed` logs; Shopify retries are finite, so a persistent failure needs manual reconciliation. Cancellations that happened before webhook registration are not automatically backfilled.

Run `node --test tests/popup-cancellation.test.mjs` for signature, duplicate, record-matching, early-delivery, and failure-path tests. These use mocks and do not cancel real orders.

Setup reference: [Shopify webhook creation](https://help.shopify.com/en/manual/fulfillment/setup/notifications/webhooks). Signature reference: [Shopify delivery verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).

## Validation

Run `node --test tests/popup-reservations.test.mjs`. Tests mock Shopify, Supabase and messaging; they cover competing requests, retry safety, metadata, the existing event schema, unchanged workflow timestamps, deferred SMS and partial failures. Run `node tests/popup-reservation.test.cjs` in the theme repository for client behavior. No live orders or texts are created by these tests. A staging-store integration test remains necessary before launch.

## API references

- [Shopify order creation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCreate)
- [Shopify order input and custom attributes](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/OrderCreateOrderInput)
- [Shopify inventory behavior](https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderCreateInputsInventoryBehavior)
- [Shopify inventory claim errors](https://shopify.dev/docs/api/admin-graphql/2026-01/enums/OrderCreateUserErrorCode)
