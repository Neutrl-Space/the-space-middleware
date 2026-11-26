# Combined product-page monitoring

Prepared November 26, 2026 for the November 25 team-sync follow-up. Not deployed or enabled in Better Stack yet.

## Behavior

`GET /api/health?check=products` requires the existing `Authorization: Bearer <MONITORING_SECRET>` header. It reads the Shopify product catalog and checks each product published to the Online Store. New published products join automatically; drafts, archived products and products without an Online Store URL are skipped. Shopify documents `onlineStoreUrl: null` as unpublished to that channel: https://shopify.dev/docs/api/admin-graphql/2026-01/objects/Product.

The endpoint returns HTTP 200 only when every discovered page returns HTTP 200. A page failure returns HTTP 503 with public product handles and HTTP status codes. Failed catalog reads, an empty published catalog, incomplete pagination and timeouts also return 503, rather than a partial success. Catalog scans stop after 1,000 records; checks run at most three page requests concurrently, with six seconds per page and twenty seconds overall.

Only HTTPS URLs on neutrlspaceny.com or www.neutrlspaceny.com are allowed. Redirects must retain the same product path; redirects to the homepage, another product or another host fail. No monitoring credentials are sent to product pages. Response bodies are cancelled after headers are received.

This checks HTTP availability. It does not validate rendered JavaScript, images, prices, checkout, performance, or error pages that incorrectly return HTTP 200. Removing one published product from the catalog removes it from the check; it is not an expected-inventory audit.

## Rollout

1. Push and review the middleware change, merge it and wait for the production deployment.
2. Privately call the endpoint using the existing monitoring secret. Expect `status: ok`, `failedCount: 0`, and a product count matching the published catalog (eight observed November 26). Do not paste the secret or full authenticated command into chat, screenshots or logs.
3. Create one Better Stack monitor after deployment verification and approval. Proposed settings:

| Setting | Value |
| --- | --- |
| Name | NEUTRLSPACE — All Product Pages |
| URL | https://the-space-middleware.vercel.app/api/health?check=products |
| Type / method | Successful HTTP status / GET |
| Frequency | 3 minutes |
| Request timeout | 30 seconds |
| Confirmation / recovery | 1 minute / 1 minute |
| Authentication | Existing monitoring Bearer secret, entered privately |
| Notifications | Primary responder by email, same policy as backend health |

Cloning the existing middleware-health monitor in the dashboard can retain its private authorization header. Change only the name, URL and the reviewed settings above; verify the clone is Up. Keep the existing individual After Hours Knit check during rollout. This adds one monitor rather than seven, so the five observed monitors become six.

4. Confirm delivery to the intended responder and NSP support using the existing notification test workflow. Do not deliberately break a live product to test alerts.

## Validation

All 151 middleware tests pass, including seven new tests covering pagination, unavailable pages, unsafe redirects, incomplete catalogs, concurrency, timeouts and authorization before catalog access. A read-only live scan using the existing stored Shopify token discovered eight published products and returned `status: ok`, `productsChecked: 8`, `failedCount: 0`. No catalog, orders or customer data was changed, and no token refresh was performed.

An initial scan using a custom monitor User-Agent received seven HTTP 429 responses. A single-request comparison returned 200 with the HTTP client's standard identifier and 429 with the custom one. The checker now leaves identification to the standard Fetch client; the corrected complete scan passed. It does not impersonate a browser or verified bot, retry 429s, or count them as healthy. Recheck from the deployed Vercel endpoint because an outbound IP or storefront rule can affect the result. The authenticated deployed endpoint and Better Stack monitor still require rollout verification.
