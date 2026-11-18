import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsletterOfferHandler, SESSION_TAG_PREFIX } from '../lib/newsletter-offer.js';
import { processNewsletterReminder, REMINDER_TAG, newsletterConfig } from '../lib/newsletter.js';

const token = 'a'.repeat(64), id = 'gid://shopify/Customer/123';
const now = () => new Date('2026-11-18T12:00:00Z');
const env = { SHOPIFY_SHOP: 'test', SHOPIFY_CLIENT_SECRET: 'test-only-secret', NEWSLETTER_ENABLED: 'true',
  NEWSLETTER_INSTANT_ENABLED: 'true', POPUP_ALLOWED_ORIGINS: 'https://store.test' };
const config = newsletterConfig(env);
const rules = { ...config.rules, launchedAt: '2026-11-17T00:00:00Z' };
const job = { id: 'job', customer_id: id, rules, code: 'HELLO-23456789', status: 'published',
  starts_at: '2026-11-18T00:00:00Z', ends_at: '2026-11-19T00:00:00Z', reminder_lease_token: 'lease' };
function record() { return { id, tags: ['newsletter-popup', `${SESSION_TAG_PREFIX}${token}`], numberOfOrders: '0',
  emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: '2026-11-18T00:00:00Z' } }; }
function discount() { return { id: 'discount', codeDiscount: { __typename: 'DiscountCodeBasic', title: 'NEUTRL welcome / job',
  startsAt: job.starts_at, endsAt: job.ends_at, usageLimit: 1, appliesOncePerCustomer: true, asyncUsageCount: 0,
  codes: { nodes: [{ code: job.code }] }, combinesWith: rules.combinesWith,
  context: { __typename: 'DiscountCustomers', customers: [{ id }] },
  customerGets: { items: { __typename: 'AllDiscountItems' }, value: { __typename: 'DiscountPercentage', percentage: 0.15 } } } }; }
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; },
  json(body) { this.body = body; return this; }, end() { return this; } }; }
function request(body = { token }) { return { method: 'POST', body, headers: { origin: 'https://store.test', 'content-type': 'application/json' } }; }
function fixture() {
  const customer = record(), node = discount(), calls = [], finishes = [];
  let assignment = { ...job }, matches = [{ id, tags: customer.tags }], limited = false, tagTimeout = false;
  const store = { async requireReady() {}, async allowStatus(...keys) { assert.ok(keys.every((key) => /^[a-f0-9]{64}$/.test(key))); return !limited; },
    async enqueue(event) { calls.push({ event }); }, async claimCustomer() { return null; }, async assignment() { return assignment; },
    async checkReminderLease() {}, async finishReminder(_, state, reason) { finishes.push({ state, reason }); } };
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('query NewsletterSignupSession')) return { customers: { nodes: matches } };
    if (query.includes('query NewsletterCustomer')) return { customer };
    if (query.includes('query NewsletterDiscount')) return { codeDiscountNodeByCode: node };
    if (query.includes('mutation NewsletterReminderReady')) {
      customer.tags.push(REMINDER_TAG);
      if (tagTimeout) { tagTimeout = false; throw new Error('Timeout after tag added'); }
      return { tagsAdd: { userErrors: [] } };
    }
    throw new Error('Unexpected query');
  };
  return { customer, node, store, graphql, calls, finishes, set assignment(value) { assignment = value; },
    set matches(value) { matches = value; }, set limited(value) { limited = value; }, set tagTimeout(value) { tagTimeout = value; },
    async offer(req = request(), settings = env) { const res = response(); await createNewsletterOfferHandler({ store, graphql, env: settings, now })(req, res); return res; },
    reminder: (options = {}) => processNewsletterReminder({ store, graphql, job, now, ...options }) };
}

test('offer requires allowed origin, POST JSON and a 256-bit signup token before accessing Shopify', async () => {
  for (const [change, expected] of [
    [(r) => { r.headers.origin = 'https://evil.test'; }, 403],
    [(r) => { r.method = 'GET'; }, 405],
    [(r) => { r.headers['content-type'] = 'text/plain'; }, 415],
    [(r) => { r.body = { email: 'guess@example.com', customerId: id }; }, 400],
    [(r) => { r.body.token = "a' OR tag:newsletter-popup"; }, 400],
    [(r) => { r.body = { token, extra: 'x'.repeat(1024) }; }, 413],
  ]) {
    const f = fixture(), req = request(); change(req); assert.equal((await f.offer(req)).code, expected); assert.equal(f.calls.length, 0);
  }
});

test('disabled integration and non-24-hour rules fail closed; CORS preflight has no side effects', async () => {
  for (const change of [{ NEWSLETTER_INSTANT_ENABLED: 'false' }, { NEWSLETTER_ENABLED: 'false' }, { NEWSLETTER_DISCOUNT_DAYS: '7' }]) {
    const f = fixture(); assert.equal((await f.offer(request(), { ...env, ...change })).code, 503); assert.equal(f.calls.length, 0);
  }
  const f = fixture(), req = request(); req.method = 'OPTIONS'; assert.equal((await f.offer(req)).code, 204); assert.equal(f.calls.length, 0);
});

test('durable rate limit precedes Shopify calls', async () => {
  const f = fixture(); f.limited = true;
  const res = await f.offer(); assert.equal(res.code, 429); assert.equal(f.calls.length, 0); assert.equal(res.headers['Retry-After'], '60');
});

test('missing, fuzzy or ambiguous session tags never disclose or issue a code', async () => {
  for (const matches of [[], [{ id, tags: ['newsletter-popup'] }], [record(), record()]]) {
    const f = fixture(); f.matches = matches;
    assert.deepEqual((await f.offer()).body, { status: 'pending' }); assert.equal(f.calls.some((call) => call.event), false);
  }
});

test('pending email confirmation cannot enqueue issuance or disclose a code', async () => {
  const f = fixture(); f.customer.emailMarketingConsent.marketingState = 'PENDING';
  assert.deepEqual((await f.offer()).body, { status: 'confirmation_required' }); assert.equal(f.calls.some((call) => call.event), false);
});

test('only a published, unused, verified Shopify offer is returned, with its original expiry', async () => {
  const f = fixture(), res = await f.offer();
  assert.equal(res.code, 200); assert.deepEqual(res.body, { status: 'ready', code: job.code, issuedAt: job.starts_at, expiresAt: job.ends_at });
  assert.match(res.headers['Cache-Control'], /no-store/); assert.equal(JSON.stringify(res.body).includes(id), false);
});

test('baseline exclusions, orders, redemption, revocation, expiry and changed discounts prevent disclosure', async () => {
  for (const change of [
    (f) => { f.assignment = { ...job, status: 'ineligible', reason: 'existing_subscriber' }; },
    (f) => { f.assignment = { ...job, revocation_requested: true }; },
    (f) => { f.assignment = { ...job, redeemed_order_id: 'order' }; },
    (f) => { f.assignment = { ...job, ends_at: '2026-11-18T11:00:00Z' }; },
    (f) => { f.customer.numberOfOrders = '1'; },
    (f) => { f.node.codeDiscount.asyncUsageCount = 1; },
    (f) => { f.node.codeDiscount.customerGets.value.percentage = 0.5; },
    (f) => { delete f.node.codeDiscount.asyncUsageCount; },
  ]) {
    const f = fixture(); change(f); const res = await f.offer(); assert.notEqual(res.body.status, 'ready'); assert.equal(res.body.code, undefined);
  }
});

test('a pending assignment stays pending rather than exposing a merely reserved code', async () => {
  const f = fixture(); f.assignment = { ...job, status: 'pending' }; assert.deepEqual((await f.offer()).body, { status: 'pending' });
});

test('reminder triggers once after 12 hours and ambiguous tag timeout cannot retrigger email', async () => {
  const f = fixture(); f.tagTimeout = true;
  assert.equal(await f.reminder(), 'retry'); assert.equal(await f.reminder(), 'published');
  assert.equal(f.calls.filter((call) => call.query?.includes('mutation NewsletterReminderReady')).length, 1);
  assert.equal(f.finishes.at(-1).state, 'published');
});

test('reminder suppresses used, expired, unsubscribed and purchased offers', async () => {
  for (const change of [
    (f) => { f.node.codeDiscount.asyncUsageCount = 1; },
    (f) => { f.customer.numberOfOrders = '1'; },
    (f) => { f.customer.emailMarketingConsent.marketingState = 'UNSUBSCRIBED'; },
  ]) {
    const f = fixture(); change(f); assert.equal(await f.reminder(), 'skipped'); assert.equal(f.customer.tags.includes(REMINDER_TAG), false);
  }
  const f = fixture(); assert.equal(await f.reminder({ now: () => new Date('2026-11-19T00:00:00Z') }), 'skipped');
  assert.equal(f.customer.tags.includes(REMINDER_TAG), false);
});

test('reminder fails closed before 12 hours, on missing usage, mismatched discount, or lost lease', async () => {
  for (const change of [
    (f) => { delete f.node.codeDiscount.asyncUsageCount; },
    (f) => { f.node.codeDiscount.context.customers[0].id = 'someone-else'; },
    (f) => { f.store.checkReminderLease = async () => { throw new Error('Lease lost'); }; },
  ]) {
    const f = fixture(); change(f); assert.equal(await f.reminder(), 'retry'); assert.equal(f.customer.tags.includes(REMINDER_TAG), false);
  }
  const f = fixture(); assert.equal(await f.reminder({ now: () => new Date('2026-11-18T11:59:59Z') }), 'retry');
});
