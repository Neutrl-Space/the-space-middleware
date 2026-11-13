import crypto from 'node:crypto';
import { newsletterConfig } from './newsletter.js';

export const NEWSLETTER_WEBHOOK_TOPICS = ['CUSTOMERS_CREATE', 'CUSTOMERS_EMAIL_MARKETING_CONSENT_UPDATE', 'ORDERS_CREATE'];
const FIELDS = 'id topic uri format filter includeFields apiVersion { handle }';

export function newsletterWebhookUrl(env) {
  let base;
  try { base = new URL(env.MIDDLEWARE_URL); } catch { throw new Error('Set MIDDLEWARE_URL to the deployed middleware HTTPS URL.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new Error('MIDDLEWARE_URL must be a public HTTPS URL without credentials, query parameters or fragments.');
  }
  return new URL('/api/newsletter/webhook', base).href;
}

export async function probeNewsletterWebhook({ url, env, fetcher = fetch }) {
  const config = newsletterConfig(env);
  if (!config.webhooksEnabled) throw new Error('Set NEWSLETTER_WEBHOOKS_ENABLED=true while leaving NEWSLETTER_ENABLED=false for staged setup.');
  if (!env.SHOPIFY_CLIENT_SECRET) throw new Error('SHOPIFY_CLIENT_SECRET is not configured.');
  // A signed, unsubscribed consent event authenticates the deployed raw-body path without enqueueing anyone.
  const body = JSON.stringify({ customer_id: '1', email_marketing_consent: { state: 'not_subscribed' } });
  const signature = crypto.createHmac('sha256', env.SHOPIFY_CLIENT_SECRET).update(body).digest('base64');
  const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Shop-Domain': config.shop,
      'X-Shopify-Topic': 'customers_email_marketing_consent/update', 'X-Shopify-Webhook-Id': `setup-${crypto.randomUUID()}`,
      'X-Shopify-Hmac-Sha256': signature }, body });
  if (!response.ok) throw new Error(`Webhook endpoint check failed (HTTP ${response.status}). Deploy the latest code and enable webhook collection in Vercel first.`);
  const result = await response.json();
  if (result.accepted !== true) throw new Error('Webhook endpoint did not confirm receipt. Check the deployment URL and access protection.');
}

export async function configureNewsletterWebhooks({ graphql, env = process.env, apply = false, probe = probeNewsletterWebhook }) {
  const url = newsletterWebhookUrl(env);
  const expectedVersion = env.SHOPIFY_API_VERSION || '2026-01';
  const subscriptions = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const data = await graphql(`query NewsletterWebhookSubscriptions($after: String, $topics: [WebhookSubscriptionTopic!]) {
      webhookSubscriptions(first: 100, after: $after, topics: $topics) {
        nodes { ${FIELDS} } pageInfo { hasNextPage endCursor }
      }
    }`, { after, topics: NEWSLETTER_WEBHOOK_TOPICS });
    subscriptions.push(...data.webhookSubscriptions.nodes);
    if (!data.webhookSubscriptions.pageInfo.hasNextPage) break;
    const cursor = data.webhookSubscriptions.pageInfo.endCursor;
    if (!cursor || cursor === after || page === 9) throw new Error('Webhook inventory is incomplete; no subscriptions were changed.');
    after = cursor;
  }
  const existing = new Map();
  for (const topic of NEWSLETTER_WEBHOOK_TOPICS) {
    const matches = subscriptions.filter((item) => item.topic === topic && item.uri.replace(/\/$/, '') === url);
    if (matches.length > 1) throw new Error(`${topic} has duplicate subscriptions for this endpoint. Review them before registering more.`);
    if (!matches.length) continue;
    const item = matches[0];
    if (item.uri !== url || item.format !== 'JSON' || item.filter || item.includeFields?.length || item.apiVersion.handle !== expectedVersion) {
      throw new Error(`${topic} has an incompatible existing subscription. Check its URL, format, filters and app webhook API version.`);
    }
    existing.set(topic, item);
  }
  if (apply) await probe({ url, env });
  const output = [];
  for (const topic of NEWSLETTER_WEBHOOK_TOPICS) {
    if (existing.has(topic)) { output.push({ topic, status: 'existing' }); continue; }
    if (!apply) { output.push({ topic, status: 'would-create' }); continue; }
    const data = await graphql(`mutation NewsletterWebhookCreate($topic: WebhookSubscriptionTopic!, $input: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $input) {
        webhookSubscription { ${FIELDS} } userErrors { field message }
      }
    }`, { topic, input: { uri: url, format: 'JSON' } });
    const result = data.webhookSubscriptionCreate;
    if (!result?.webhookSubscription || result.userErrors?.length) throw new Error(`${topic} registration failed. Check Shopify permissions; no existing subscriptions were deleted.`);
    if (result.webhookSubscription.apiVersion.handle !== expectedVersion) {
      throw new Error(`${topic} was created with a different webhook API version. Set the app's Webhooks API version to ${expectedVersion}, release it, and re-run the check.`);
    }
    output.push({ topic, status: 'created' });
  }
  return { url, subscriptions: output };
}
