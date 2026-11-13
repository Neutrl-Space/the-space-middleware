import crypto from 'node:crypto';

export const READY_TAG = 'ns-welcome-ready';
export const CODE_PREFIX = 'ns-welcome-code:';
export const EXPIRY_PREFIX = 'ns-welcome-expires:';
const TOPICS = new Set(['customers/create', 'customers_email_marketing_consent/update', 'orders/create']);
const MAX_BODY_BYTES = 256 * 1024;
const CUSTOMER_FIELDS = `id tags numberOfOrders emailMarketingConsent { marketingState marketingOptInLevel consentUpdatedAt }`;
const DISCOUNT_FIELDS = `id codeDiscount { __typename ... on DiscountCodeBasic {
  title startsAt endsAt usageLimit appliesOncePerCustomer
  codes(first: 2) { nodes { code } }
  combinesWith { orderDiscounts productDiscounts shippingDiscounts }
  context { __typename ... on DiscountCustomers { customers { id } } }
  customerGets { items { __typename } value { __typename ... on DiscountPercentage { percentage } } }
} }`;

function error(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }
function integer(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) throw error('Invalid newsletter configuration.', 503);
  return number;
}
export function newsletterConfig(env = process.env) {
  const shop = String(env.SHOPIFY_SHOP || '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '').replace(/\.myshopify\.com$/, '');
  const campaign = env.NEWSLETTER_CAMPAIGN || 'welcome-v1';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(shop) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(campaign)) {
    throw error('Newsletter shop or campaign is not configured.', 503);
  }
  return {
    enabled: env.NEWSLETTER_ENABLED === 'true',
    webhooksEnabled: env.NEWSLETTER_WEBHOOKS_ENABLED == null
      ? env.NEWSLETTER_ENABLED === 'true' : env.NEWSLETTER_WEBHOOKS_ENABLED === 'true',
    shop: `${shop}.myshopify.com`, campaign,
    rules: { percentage: 15, validityDays: integer(env.NEWSLETTER_DISCOUNT_DAYS, 7, 1, 90),
      usageLimit: integer(env.NEWSLETTER_DISCOUNT_USAGE_LIMIT, 1, 1, 10), firstPurchaseOnly: true,
      sourceTag: 'newsletter-popup', combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false } },
  };
}
function customerGid(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw error('Unsafe customer identifier.', 400);
  const text = String(value ?? '');
  if (/^gid:\/\/shopify\/Customer\/[1-9]\d*$/.test(text)) return text;
  if (/^[1-9]\d*$/.test(text)) return `gid://shopify/Customer/${text}`;
  throw error('Invalid customer identifier.', 400);
}
export function verifyNewsletterWebhook(raw, headers, env = process.env) {
  const config = newsletterConfig(env);
  if (!config.webhooksEnabled) throw error('Newsletter webhook collection is not enabled.', 503);
  if (headers['x-shopify-shop-domain'] !== config.shop || !TOPICS.has(headers['x-shopify-topic'])) throw error('Invalid webhook source.', 401);
  const secrets = [env.SHOPIFY_CLIENT_SECRET, env.SHOPIFY_PREVIOUS_CLIENT_SECRET].filter(Boolean);
  if (!secrets.length) throw error('Webhook verification is not configured.', 503);
  const signature = headers['x-shopify-hmac-sha256'];
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw error('Invalid webhook signature.', 401);
  const received = Buffer.from(signature, 'base64');
  if (!secrets.some((secret) => crypto.timingSafeEqual(crypto.createHmac('sha256', secret).update(raw).digest(), received))) {
    throw error('Invalid webhook signature.', 401);
  }
  const eventId = headers['x-shopify-webhook-id'];
  if (typeof eventId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(eventId)) throw error('Missing webhook identifier.', 400);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw error('Invalid webhook JSON.', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error('Invalid webhook JSON.', 400);
  const topic = headers['x-shopify-topic'];
  const order = topic === 'orders/create';
  // No raw customer payloads, names, email addresses, or credentials are stored.
  if (order && !body.customer?.id && !body.customer?.admin_graphql_api_id) return { config, event: null };
  const id = order ? body.customer.admin_graphql_api_id || body.customer.id
    : body.admin_graphql_api_id || body.customer_id || body.id;
  const consent = body.email_marketing_consent;
  if (topic === 'customers_email_marketing_consent/update' && consent?.state !== 'subscribed') return { config, event: null };
  const consentAt = consent?.consent_updated_at;
  const orderId = order ? String(body.admin_graphql_api_id || body.id || '') : null;
  if (order && !/^(gid:\/\/shopify\/Order\/)?[1-9]\d*$/.test(orderId)) throw error('Invalid order identifier.', 400);
  const event = { eventId, shop: config.shop, topic, customerId: customerGid(id),
    kind: order ? 'order' : 'subscribe', orderId,
    codes: order && Array.isArray(body.discount_codes) ? body.discount_codes.map((item) => item?.code)
      .filter((code) => typeof code === 'string').map((code) => code.toUpperCase()) : [],
    consentAt: typeof consentAt === 'string' && Number.isFinite(Date.parse(consentAt)) ? new Date(consentAt).toISOString() : null,
    optInLevel: typeof consent?.opt_in_level === 'string' ? consent.opt_in_level : null,
  };
  return { config, event };
}

export function createNewsletterWebhookHandler({ store, env = process.env }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed.' }); }
    try {
      // bodyParser must be disabled: authenticate exactly the bytes Shopify signed.
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > MAX_BODY_BYTES) throw error('Webhook too large.', 413);
        chunks.push(Buffer.from(chunk));
      }
      const { config, event } = verifyNewsletterWebhook(Buffer.concat(chunks), req.headers, env);
      if (event) await store.enqueue(event, config);
      // Only acknowledge after the database transaction commits. A scheduled worker handles Shopify calls.
      return res.status(200).json({ accepted: true });
    } catch (failure) {
      return res.status(failure.statusCode || 503).json({ error: failure.statusCode ? failure.message : 'Webhook could not be saved. Retry delivery.' });
    }
  };
}

function result(data, field) {
  const value = data?.[field];
  if (!value || value.userErrors?.length) throw new Error(`Shopify ${field} did not complete.`);
  return value;
}
async function customer(graphql, id) {
  const data = await graphql(`query NewsletterCustomer($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} } }`, { id });
  return data.customer;
}
function eligible(record, rules) {
  if (!record || !record.tags.includes(rules.sourceTag)) return 'missing_source';
  if (record.emailMarketingConsent?.marketingState !== 'SUBSCRIBED') return 'not_subscribed';
  if (!Number.isFinite(Date.parse(rules.launchedAt)) || !Number.isFinite(Date.parse(record.emailMarketingConsent.consentUpdatedAt)) ||
      Date.parse(record.emailMarketingConsent.consentUpdatedAt) < Date.parse(rules.launchedAt)) return 'pre_launch_subscription';
  if (rules.firstPurchaseOnly && (record.numberOfOrders == null || Number(record.numberOfOrders) !== 0)) return 'has_orders';
  return null;
}
function sameShopifySecond(left, right) {
  const first = Date.parse(left), second = Date.parse(right);
  return Number.isFinite(first) && Number.isFinite(second) && Math.floor(first / 1000) === Math.floor(second / 1000);
}
function validateDiscount(node, job, deactivating = false) {
  const discount = node?.codeDiscount;
  const rules = job.rules;
  if (!discount || discount.__typename !== 'DiscountCodeBasic' || discount.title !== `NEUTRL welcome / ${job.id}` ||
      discount.context?.__typename !== 'DiscountCustomers' || discount.context.customers.length !== 1 ||
      discount.context.customers[0].id !== job.customer_id ||
      !sameShopifySecond(discount.startsAt, job.starts_at) || (!deactivating && !sameShopifySecond(discount.endsAt, job.ends_at)) ||
      discount.usageLimit !== rules.usageLimit || discount.appliesOncePerCustomer !== true ||
      discount.codes.nodes.length !== 1 || discount.codes.nodes[0].code !== job.code ||
      discount.customerGets?.items?.__typename !== 'AllDiscountItems' ||
      discount.customerGets?.value?.__typename !== 'DiscountPercentage' ||
      discount.customerGets.value.percentage !== rules.percentage / 100 ||
      Object.keys(rules.combinesWith).some((key) => discount.combinesWith?.[key] !== rules.combinesWith[key])) {
    throw new Error('Discount reconciliation requires manual review.');
  }
  return node.id;
}
async function findDiscount(graphql, code) {
  const data = await graphql(`query NewsletterDiscount($code: String!) {
    codeDiscountNodeByCode(code: $code) { ${DISCOUNT_FIELDS} }
  }`, { code });
  return data.codeDiscountNodeByCode;
}
async function ensureDiscount(graphql, job) {
  let node = await findDiscount(graphql, job.code);
  if (!node) {
    const data = await graphql(`mutation NewsletterDiscountCreate($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field code message } }
    }`, { input: {
      title: `NEUTRL welcome / ${job.id}`, code: job.code, startsAt: job.starts_at, endsAt: job.ends_at,
      usageLimit: job.rules.usageLimit, appliesOncePerCustomer: true,
      context: { customers: { add: [job.customer_id] } }, combinesWith: job.rules.combinesWith,
      customerGets: { value: { percentage: job.rules.percentage / 100 }, items: { all: true } },
    } });
    result(data, 'discountCodeBasicCreate');
    node = await findDiscount(graphql, job.code);
  }
  return validateDiscount(node, job);
}
async function revoke(graphql, job) {
  const node = job.code ? await findDiscount(graphql, job.code) : null;
  if (node) {
    const id = validateDiscount(node, job, true);
    result(await graphql(`mutation NewsletterDiscountDeactivate($id: ID!) {
      discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { field message } }
    }`, { id }), 'discountCodeDeactivate');
  }
  const record = await customer(graphql, job.customer_id);
  if (record?.tags.includes(READY_TAG)) result(await graphql(`mutation NewsletterRemoveReady($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }`, { id: job.customer_id, tags: [READY_TAG] }), 'tagsRemove');
}
async function publish(graphql, job, record) {
  const tags = [`${CODE_PREFIX}${job.code}`, `${EXPIRY_PREFIX}${job.ends_at}`, READY_TAG];
  const stale = record.tags.filter((tag) => (tag.startsWith(CODE_PREFIX) || tag.startsWith(EXPIRY_PREFIX)) && !tags.includes(tag));
  // Don't replace an already-announced offer and accidentally retrigger a welcome email.
  if (stale.length) throw new Error('Conflicting newsletter tags require manual review.');
  result(await graphql(`mutation NewsletterAssignmentMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { key } userErrors { field message } }
  }`, { metafields: [
    { ownerId: job.customer_id, namespace: 'neutrl_newsletter', key: 'code', type: 'single_line_text_field', value: job.code },
    { ownerId: job.customer_id, namespace: 'neutrl_newsletter', key: 'expires_at', type: 'date_time', value: job.ends_at },
    { ownerId: job.customer_id, namespace: 'neutrl_newsletter', key: 'campaign', type: 'single_line_text_field', value: job.campaign },
  ] }), 'metafieldsSet');
  // This atomic tag addition is the email handoff. Retrying the same tags doesn't add them a second time.
  result(await graphql(`mutation NewsletterReady($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }`, { id: job.customer_id, tags }), 'tagsAdd');
}

function welcomeCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  return `HELLO-${Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('')}`;
}

export async function processNewsletterJob({ store, graphql, job, now = () => new Date(), code = welcomeCode }) {
  let stage = 'customer_lookup_failed';
  try {
    let record = await customer(graphql, job.customer_id);
    const reason = eligible(record, job.rules);
    // Customer creation and consent webhooks can arrive before Shopify finishes applying source tags.
    if (!job.code && !job.revocation_requested && ['missing_source', 'not_subscribed'].includes(reason) && job.attempts <= 5) {
      await store.fail(job, reason);
      return 'retry';
    }
    if (job.revocation_requested || job.redeemed_order_id || reason) {
      if (job.code) await revoke(graphql, job);
      await store.finish(job, { status: job.redeemed_order_id ? 'redeemed' : job.code ? 'revoked' : 'ineligible', reason: reason || 'order_received' });
      return 'ineligible';
    }
    if (!job.code) {
      stage = 'reservation_failed';
      // Shopify returns discount timestamps at whole-second precision. Match that on new reservations;
      // reconciliation above also accepts legacy reservations with fractional seconds in the same second.
      const startsAt = new Date(Math.floor(now().getTime() / 1000) * 1000);
      job = await store.reserve(job, { code: code(), starts_at: startsAt.toISOString(),
        ends_at: new Date(startsAt.getTime() + job.rules.validityDays * 86400000).toISOString(),
        consent_at: record.emailMarketingConsent.consentUpdatedAt,
        opt_in_level: record.emailMarketingConsent.marketingOptInLevel,
      });
    }
    if (Date.parse(job.ends_at) <= now().getTime()) {
      await store.finish(job, { status: 'expired', reason: 'expired_before_handoff' });
      return 'expired';
    }
    stage = 'discount_assignment_failed';
    const discountId = await ensureDiscount(graphql, job);
    stage = 'lease_check_failed';
    await store.checkLease(job);
    // Re-read consent and order count after discount creation, before triggering email.
    stage = 'customer_recheck_failed';
    record = await customer(graphql, job.customer_id);
    const changed = eligible(record, job.rules);
    if (changed) {
      await revoke(graphql, job);
      await store.finish(job, { status: 'revoked', reason: changed, discount_id: discountId });
      return 'revoked';
    }
    stage = 'assignment_publish_failed';
    await publish(graphql, job, record);
    stage = 'assignment_save_failed';
    await store.finish(job, { status: 'published', reason: null, discount_id: discountId, published_at: now().toISOString() });
    return 'published';
  } catch {
    // Preserve the reserved code and original expiry, including after ambiguous API timeouts.
    await store.fail(job, stage);
    return 'retry';
  }
}

export async function runNewsletterWorker({ store, graphql, config, limit = 10, deadline = Date.now() + 45000 }) {
  if (!config.enabled) throw error('Newsletter integration is not enabled.', 503);
  await store.requireReady(config);
  let processed = 0, retry = 0;
  while (processed < limit && Date.now() < deadline) {
    const job = await store.claim(config);
    if (!job) break;
    if (await processNewsletterJob({ store, graphql, job }) === 'retry') retry++;
    processed++;
  }
  return { processed, retry };
}

export function createNewsletterProcessHandler({ store, graphql, env = process.env, now = () => Date.now() }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed.' });
    }
    const secret = env.CRON_SECRET;
    if (!secret || secret.length < 32) return res.status(503).json({ error: 'Newsletter worker is not configured.' });
    const received = crypto.createHash('sha256').update(String(req.headers.authorization || '')).digest();
    const expected = crypto.createHash('sha256').update(`Bearer ${secret}`).digest();
    let authorized = crypto.timingSafeEqual(received, expected);
    // Supabase pg_net queues headers in a database table. Use a short-lived signature there,
    // rather than placing the reusable CRON_SECRET in the request queue.
    if (!authorized) {
      const timestamp = req.headers['x-newsletter-timestamp'];
      const signature = req.headers['x-newsletter-signature'];
      if (typeof timestamp === 'string' && /^\d{10}$/.test(timestamp) &&
          typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature) &&
          Math.abs(Math.floor(now() / 1000) - Number(timestamp)) <= 60) {
        const message = `newsletter-worker\n${req.method}\n/api/newsletter/process\n${timestamp}`;
        const digest = crypto.createHmac('sha256', secret).update(message).digest();
        authorized = crypto.timingSafeEqual(digest, Buffer.from(signature, 'hex'));
      }
    }
    if (!authorized) return res.status(401).json({ error: 'Unauthorized.' });
    try {
      const output = await runNewsletterWorker({ store, graphql, config: newsletterConfig(env), limit: 5 });
      return res.status(200).json(output);
    } catch {
      return res.status(503).json({ error: 'Newsletter processing did not complete. Pending jobs are retained.' });
    }
  };
}
