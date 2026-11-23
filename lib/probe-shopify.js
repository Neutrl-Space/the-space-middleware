import { ProbeCheckError } from './probe-errors.js';
// Dedicated test-app authentication. Never imports the production Shopify session client.
export function createProbeShopifyGraphql({ shop, clientId, clientSecret, fetchImpl = fetch, now = Date.now }) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !clientId || !clientSecret) {
    throw new ProbeCheckError('Test app credentials are required.');
  }
  let token, expiresAt = 0;
  return async (query, variables = {}) => {
    if (!token || now() >= expiresAt - 60000) {
      const response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      });
      if (!response.ok) throw new ProbeCheckError(`Development Shopify authentication failed (HTTP ${response.status}). Check the test app credentials, installation, and that app and store share a Shopify organization.`);
      const body = await response.json();
      if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in <= 60) {
        throw new ProbeCheckError('Development Shopify token was not returned.');
      }
      token = body.access_token;
      expiresAt = now() + body.expires_in * 1000;
    }
    const response = await fetchImpl(`https://${shop}/admin/api/2026-01/graphql.json`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new ProbeCheckError(`Development Shopify request failed (HTTP ${response.status}).`);
    const body = await response.json();
    if (body.errors?.length || !body.data) throw new ProbeCheckError('Development Shopify query failed.');
    return body.data;
  };
}
