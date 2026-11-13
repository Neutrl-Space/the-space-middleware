import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { newsletterConfig, verifyNewsletterWebhook, createNewsletterWebhookHandler, createNewsletterProcessHandler, processNewsletterJob, runNewsletterWorker, READY_TAG, CODE_PREFIX, EXPIRY_PREFIX } from '../lib/newsletter.js';
import { createNewsletterStore } from '../lib/newsletter-store.js';

const env = { SHOPIFY_SHOP: 'neutrl-test', SHOPIFY_CLIENT_SECRET: 'test-only-secret', NEWSLETTER_ENABLED: 'true' };
const config = newsletterConfig(env);
const now = () => new Date('2026-11-12T12:00:00.000Z');
const id = 'gid://shopify/Customer/123';
const payload = { customer_id: 123, email_marketing_consent: { state: 'subscribed', consent_updated_at: '2026-11-12T11:00:00Z', opt_in_level: 'confirmed_opt_in' } };
function signed(body = payload, secret = env.SHOPIFY_CLIENT_SECRET, topic = 'customers_email_marketing_consent/update') {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { raw, headers: { 'x-shopify-shop-domain': config.shop, 'x-shopify-topic': topic,
    'x-shopify-webhook-id': 'event-123', 'x-shopify-hmac-sha256': crypto.createHmac('sha256', secret).update(raw).digest('base64') } };
}
function response() { return { setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } }; }

test('webhooks require the signed raw bytes, matching shop, allowed topic, ID and enabled configuration', () => {
  const request = signed();
  const event = verifyNewsletterWebhook(request.raw, request.headers, env).event;
  assert.equal(event.customerId, id);
  assert.equal(event.optInLevel, 'confirmed_opt_in');
  assert.equal(event.consentAt, '2026-11-12T11:00:00.000Z');
  assert.equal(JSON.stringify(event).includes('email_address'), false);
  for (const [raw, headers] of [
    [Buffer.from('{}'), request.headers],
    [request.raw, { ...request.headers, 'x-shopify-shop-domain': 'other.myshopify.com' }],
    [request.raw, { ...request.headers, 'x-shopify-topic': 'customers/update' }],
    [request.raw, { ...request.headers, 'x-shopify-webhook-id': '' }],
    [request.raw, { ...request.headers, 'x-shopify-hmac-sha256': '' }],
  ]) assert.throws(() => verifyNewsletterWebhook(raw, headers, env));
  assert.throws(() => verifyNewsletterWebhook(request.raw, request.headers, { ...env, NEWSLETTER_ENABLED: 'false' }));
  assert.throws(() => newsletterConfig({ ...env, NEWSLETTER_DISCOUNT_DAYS: '0' }));
  const rotated = signed(payload, 'old-secret');
  assert.equal(verifyNewsletterWebhook(rotated.raw, rotated.headers, { ...env, SHOPIFY_PREVIOUS_CLIENT_SECRET: 'old-secret' }).event.customerId, id);
});

test('unconfirmed subscriptions do not enter the discount queue; order events retain only attribution', () => {
  for (const state of ['pending', 'not_subscribed', 'unsubscribed']) {
    const request = signed({ ...payload, email_marketing_consent: { state } });
    assert.equal(verifyNewsletterWebhook(request.raw, request.headers, env).event, null);
  }
  const request = signed({ id: 456, customer: { id: 123 }, discount_codes: [{ code: 'ns15test' }], email: 'not-stored@example.com' }, undefined, 'orders/create');
  const event = verifyNewsletterWebhook(request.raw, request.headers, env).event;
  assert.equal(event.kind, 'order'); assert.deepEqual(event.codes, ['NS15TEST']);
  assert.equal(JSON.stringify(event).includes('not-stored'), false);
});

test('staged setup collects authenticated events while discount processing stays disabled', async () => {
  const staging = { ...env, NEWSLETTER_ENABLED: 'false', NEWSLETTER_WEBHOOKS_ENABLED: 'true', CRON_SECRET: 'test-worker-secret-longer-than-32-characters' };
  const request = signed(); let queued = 0, claims = 0;
  const store = { async enqueue() { queued++; }, async requireReady() {}, async claim() { claims++; return null; } };
  const receipt = response();
  await createNewsletterWebhookHandler({ env: staging, store })(Object.assign(Readable.from([request.raw]), { method: 'POST', headers: request.headers }), receipt);
  assert.equal(receipt.code, 200); assert.equal(queued, 1);
  const worker = response();
  await createNewsletterProcessHandler({ env: staging, store })({ method: 'GET', headers: { authorization: `Bearer ${staging.CRON_SECRET}` } }, worker);
  assert.equal(worker.code, 503); assert.equal(claims, 0);
  assert.throws(() => verifyNewsletterWebhook(request.raw, request.headers, { ...env, NEWSLETTER_WEBHOOKS_ENABLED: 'false' }));
});

test('webhook acknowledges only after persistence; storage failures request redelivery', async () => {
  let saved = 0;
  const handler = createNewsletterWebhookHandler({ env, store: { async enqueue() { saved++; } } });
  const request = signed();
  const req = () => Object.assign(Readable.from([request.raw]), { method: 'POST', headers: request.headers });
  const res = response(); await handler(req(), res);
  assert.equal(res.code, 200); assert.equal(saved, 1);
  const failing = createNewsletterWebhookHandler({ env, store: { async enqueue() { throw new Error('database-secret'); } } });
  const fail = response(); await failing(req(), fail);
  assert.equal(fail.code, 503); assert.equal(JSON.stringify(fail.body).includes('database-secret'), false);
  const oversized = response(); await handler(Object.assign(Readable.from([Buffer.alloc(262145)]), { method: 'POST', headers: request.headers }), oversized);
  assert.equal(oversized.code, 413); assert.equal(saved, 1);
  const invalid = response(); await handler(Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', headers: request.headers }), invalid);
  assert.equal(invalid.code, 401); assert.equal(saved, 1);
});

function fixture(options = {}) {
  const record = { id, tags: ['newsletter-popup'], numberOfOrders: '0',
    emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'CONFIRMED_OPT_IN', consentUpdatedAt: '2026-11-12T11:00:00Z' }, ...options.customer };
  let job = { id: 'assignment-123', shop: config.shop, campaign: config.campaign, customer_id: id,
    rules: { ...config.rules, launchedAt: '2026-11-12T10:00:00Z' }, status: 'pending', lease_token: 'lease-1', attempts: 1, ...options.job };
  let discount = options.discount || null, creates = 0, failOnce = options.failOnce;
  let reads = 0;
  const calls = [], finishes = [];
  const store = {
    async reserve(current, fields) { job = { ...current, ...fields }; return job; },
    async checkLease() { if (options.interrupted) throw new Error('Lease interrupted'); },
    async finish(current, fields) { finishes.push(fields); job = { ...job, ...fields }; },
    async fail() { job.status = 'pending'; },
  };
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('query NewsletterCustomer')) {
      reads++;
      if (options.orderAfterCreate && creates) record.numberOfOrders = '1';
      if (options.unsubscribeAfterCreate && creates) record.emailMarketingConsent.marketingState = 'UNSUBSCRIBED';
      return { customer: record };
    }
    if (query.includes('query NewsletterDiscount')) return { codeDiscountNodeByCode: discount };
    if (query.includes('mutation NewsletterDiscountCreate')) {
      creates++;
      const input = variables.input;
      discount = { id: 'gid://shopify/DiscountCodeNode/456', codeDiscount: {
        __typename: 'DiscountCodeBasic', title: input.title, startsAt: input.startsAt, endsAt: input.endsAt,
        usageLimit: input.usageLimit, appliesOncePerCustomer: true, codes: { nodes: [{ code: input.code }] },
        combinesWith: input.combinesWith, context: { __typename: 'DiscountCustomers', customers: [{ id }] },
        customerGets: { items: { __typename: 'AllDiscountItems' }, value: { __typename: 'DiscountPercentage', percentage: 0.15 } },
      } };
      if (options.mutateDiscount) options.mutateDiscount(discount);
      if (failOnce === 'create-timeout') { failOnce = null; throw new Error('Timeout AFTER Shopify committed'); }
      return { discountCodeBasicCreate: { codeDiscountNode: { id: discount.id }, userErrors: options.creationErrors ? [{ message: 'Denied' }] : [] } };
    }
    if (query.includes('mutation NewsletterReady')) {
      record.tags = [...new Set([...record.tags, ...variables.tags])];
      if (failOnce === 'handoff-timeout') { failOnce = null; throw new Error('Timeout AFTER Shopify tagged'); }
      return { tagsAdd: { node: { id }, userErrors: [] } };
    }
    if (query.includes('mutation NewsletterAssignmentMetafields')) {
      return { metafieldsSet: { metafields: [], userErrors: options.metafieldError ? [{ message: 'Denied' }] : [] } };
    }
    if (query.includes('mutation NewsletterDiscountDeactivate')) {
      if (options.deactivateError) throw new Error('Timeout');
      // Shopify can change endsAt when deactivating. A later retry must still recognize this offer.
      discount.codeDiscount.endsAt = '2026-11-12T12:30:00Z';
      return { discountCodeDeactivate: { codeDiscountNode: { id: discount.id }, userErrors: [] } };
    }
    if (query.includes('mutation NewsletterRemoveReady')) {
      record.tags = record.tags.filter((tag) => !variables.tags.includes(tag));
      return { tagsRemove: { node: { id }, userErrors: [] } };
    }
    throw new Error('Unexpected GraphQL operation');
  };
  return { store, graphql, calls, finishes, record, get job() { return job; }, get creates() { return creates; },
    get discount() { return discount; }, get reads() { return reads; },
    run: () => processNewsletterJob({ store, graphql, job, now, code: () => 'NS15TEST' }),
  };
}

test('confirmed new subscriber gets a customer-restricted 15% code, seven-day expiry, one use and no stacking', async () => {
  const f = fixture(); assert.equal(await f.run(), 'published');
  const input = f.calls.find((call) => call.query.includes('mutation NewsletterDiscountCreate')).variables.input;
  assert.deepEqual(input.context, { customers: { add: [id] } });
  assert.equal(input.customerGets.value.percentage, 0.15); assert.deepEqual(input.customerGets.items, { all: true });
  assert.equal(input.usageLimit, 1); assert.equal(input.appliesOncePerCustomer, true);
  assert.deepEqual(input.combinesWith, { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false });
  assert.equal(Date.parse(input.endsAt) - Date.parse(input.startsAt), 7 * 86400000);
  assert.equal(f.job.consent_at, f.record.emailMarketingConsent.consentUpdatedAt);
  assert.ok(f.record.tags.includes(READY_TAG));
  assert.ok(f.record.tags.includes(`${CODE_PREFIX}NS15TEST`));
  assert.ok(f.record.tags.includes(`${EXPIRY_PREFIX}${input.endsAt}`));
  assert.equal(f.reads, 2);
});

test('ambiguous creation timeout reuses the persisted code and original expiry without creating a second discount', async () => {
  const f = fixture({ failOnce: 'create-timeout' });
  assert.equal(await f.run(), 'retry');
  const expiry = f.job.ends_at;
  assert.equal(f.job.status, 'pending'); assert.equal(f.record.tags.includes(READY_TAG), false);
  assert.equal(await f.run(), 'published');
  assert.equal(f.creates, 1); assert.equal(f.job.code, 'NS15TEST'); assert.equal(f.job.ends_at, expiry);
});

test('email handoff retry adds only the same tags and preserves the original offer', async () => {
  const f = fixture({ failOnce: 'handoff-timeout' });
  assert.equal(await f.run(), 'retry'); assert.ok(f.record.tags.includes(READY_TAG));
  assert.equal(await f.run(), 'published');
  assert.equal(f.record.tags.filter((tag) => tag === READY_TAG).length, 1); assert.equal(f.creates, 1);
});

test('prior orders, pre-launch subscription, missing source and unconfirmed consent cannot issue a discount', async () => {
  for (const customer of [
    { numberOfOrders: '1' }, { tags: [] },
    { emailMarketingConsent: { marketingState: 'SUBSCRIBED', consentUpdatedAt: '2020-01-01T00:00:00Z' } },
    { emailMarketingConsent: { marketingState: 'PENDING' } },
    { emailMarketingConsent: { marketingState: 'UNSUBSCRIBED' } },
  ]) {
    const f = fixture({ customer });
    assert.notEqual(await f.run(), 'published'); assert.equal(f.creates, 0);
  }
});

test('expired assignments never create a replacement or extend their expiry', async () => {
  const f = fixture({ job: { code: 'NS15OLD', starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-11-08T00:00:00Z' } });
  assert.equal(await f.run(), 'expired'); assert.equal(f.creates, 0); assert.equal(f.job.code, 'NS15OLD');
});

test('wrong-customer, wrong-amount and unrestricted discounts fail reconciliation before email handoff', async () => {
  for (const mutateDiscount of [
    (node) => { node.codeDiscount.context.customers[0].id = 'gid://shopify/Customer/999'; },
    (node) => { node.codeDiscount.customerGets.value.percentage = 0.5; },
    (node) => { node.codeDiscount.context = { __typename: 'DiscountBuyerSelectionAll' }; },
  ]) {
    const f = fixture({ mutateDiscount }); assert.equal(await f.run(), 'retry');
    assert.equal(f.record.tags.includes(READY_TAG), false);
  }
});

test('a purchase or consent withdrawal during creation revokes the code instead of handing it to email', async () => {
  for (const option of [{ orderAfterCreate: true }, { unsubscribeAfterCreate: true }]) {
    const f = fixture(option); assert.equal(await f.run(), 'revoked');
    assert.ok(f.calls.some((call) => call.query.includes('mutation NewsletterDiscountDeactivate')));
    assert.equal(f.record.tags.includes(READY_TAG), false);
  }
});

test('order revocation removes readiness and safely retries deactivation whose endsAt changed', async () => {
  const f = fixture(); await f.run();
  const job = { ...f.job, revocation_requested: true };
  for (let i = 0; i < 2; i++) {
    assert.equal(await processNewsletterJob({ store: f.store, graphql: f.graphql, job, now }), 'ineligible');
  }
  assert.equal(f.record.tags.includes(READY_TAG), false);
});

test('creation, metafield and lease failures keep jobs retryable and never signal email readiness', async () => {
  for (const options of [{ creationErrors: true }, { metafieldError: true }, { interrupted: true }]) {
    const f = fixture(options); assert.equal(await f.run(), 'retry');
    assert.equal(f.job.status, 'pending'); assert.equal(f.record.tags.includes(READY_TAG), false);
  }
});

test('worker refuses to run without a completed baseline and honors the processing limit', async () => {
  await assert.rejects(runNewsletterWorker({ config, store: { async requireReady() { throw new Error('No baseline'); } } }));
  let claims = 0;
  const f = fixture();
  const store = { ...f.store, async requireReady() {}, async claim() { claims++; return f.job; } };
  const output = await runNewsletterWorker({ config, store, graphql: f.graphql, limit: 2 });
  assert.equal(output.processed, 2); assert.equal(claims, 2);
});

test('store delegates atomic deduplication, leasing and conflict-safe finishing to the database', async () => {
  const calls = [];
  const db = { async rpc(name, args) { calls.push({ name, args }); return { data: name === 'claim_newsletter_job' ? { id: 'claimed' } : null, error: null }; } };
  const store = createNewsletterStore(db);
  await store.enqueue({ eventId: 'e' }, config);
  assert.equal((await store.claim(config)).id, 'claimed');
  await store.finish({ id: 'a', lease_token: 'token' }, { status: 'published' });
  assert.equal(calls[0].name, 'enqueue_newsletter_event');
  assert.deepEqual(calls[1].args, { shop_domain: config.shop, campaign_name: config.campaign });
  assert.equal(calls[2].args.token, 'token');
});

test('worker HTTP endpoint requires a configured secret and authentication before touching the queue', async () => {
  let claims = 0;
  const secret = 'test-only-worker-secret-with-32-characters';
  const store = { async requireReady() {}, async claim() { claims++; return null; } };
  const handler = createNewsletterProcessHandler({ store, env: { ...env, CRON_SECRET: secret } });
  for (const authorization of [undefined, 'Bearer wrong', secret]) {
    const res = response(); await handler({ method: 'POST', headers: { authorization } }, res);
    assert.equal(res.code, 401); assert.equal(claims, 0);
  }
  const method = response(); await handler({ method: 'DELETE', headers: {} }, method);
  assert.equal(method.code, 405); assert.equal(claims, 0);
  const missing = response(); await createNewsletterProcessHandler({ store, env })({ method: 'POST', headers: {} }, missing);
  assert.equal(missing.code, 503); assert.equal(claims, 0);
  const valid = response(); await handler({ method: 'GET', headers: { authorization: `Bearer ${secret}` } }, valid);
  assert.equal(valid.code, 200); assert.deepEqual(valid.body, { processed: 0, retry: 0 }); assert.equal(claims, 1);
});

test('Supabase scheduler signatures are time-limited, method-bound and cannot enable paused processing', async () => {
  const secret = 'test-only-signing-key-at-least-32-characters';
  const epoch = 1794560000;
  let claims = 0;
  const store = { async requireReady() {}, async claim() { claims++; return null; } };
  const handler = createNewsletterProcessHandler({ store, env: { ...env, CRON_SECRET: secret }, now: () => epoch * 1000 });
  function headers(timestamp = epoch, method = 'GET') {
    const stamp = String(timestamp);
    return { 'x-newsletter-timestamp': stamp, 'x-newsletter-signature': crypto.createHmac('sha256', secret)
      .update(`newsletter-worker\n${method}\n/api/newsletter/process\n${stamp}`).digest('hex') };
  }
  const valid = response(); await handler({ method: 'GET', headers: headers() }, valid);
  assert.equal(valid.code, 200); assert.equal(claims, 1);
  for (const candidate of [headers(epoch - 61), headers(epoch + 61), headers(epoch, 'POST'),
    { ...headers(), 'x-newsletter-signature': 'x'.repeat(64) },
    { ...headers(), 'x-newsletter-timestamp': 'invalid' }]) {
    const res = response(); await handler({ method: 'GET', headers: candidate }, res);
    assert.equal(res.code, 401); assert.equal(claims, 1);
  }
  const off = createNewsletterProcessHandler({ store, env: { ...env, NEWSLETTER_ENABLED: 'false', CRON_SECRET: secret }, now: () => epoch * 1000 });
  const paused = response(); await off({ method: 'GET', headers: headers() }, paused);
  assert.equal(paused.code, 503); assert.equal(claims, 1);
});
