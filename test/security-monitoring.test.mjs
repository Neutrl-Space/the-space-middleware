import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import * as Sentry from '@sentry/node';
import { reportSecurityFailure, isSecurityEvent } from '../lib/security-monitoring.js';
import { createSentryReporter, sanitizeMonitoringEvent } from '../lib/sentry.js';
import { createShopifyCallbackHandler } from '../lib/shopify-auth-callback.js';
import { createNewsletterProcessHandler, createNewsletterWebhookHandler } from '../lib/newsletter.js';
import { createNewsletterOfferHandler } from '../lib/newsletter-offer.js';
import { createHealthHandler } from '../lib/monitoring.js';
import { hasProjectAdminAccess } from '../lib/project-admin-auth.js';

const secret = 'private-token-with-at-least-32-characters';
const logs = [];
const logger = { error: value => logs.push(value), warn: value => logs.push(value) };
const env = { SHOPIFY_SHOP: 'test-shop', NEWSLETTER_ENABLED: 'true', CRON_SECRET: secret,
  SHOPIFY_CLIENT_SECRET: secret, NEWSLETTER_INSTANT_ENABLED: 'true', POPUP_ALLOWED_ORIGINS: 'https://shop.example' };
function response() {
  return { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; } };
}
function reporter() {
  const events = [], sequence = [];
  return { events, sequence, capture(event) { events.push(event); sequence.push('capture'); },
    async flush() { sequence.push('flush'); } };
}

test('fixed security signals reject arbitrary classifications and redact request data', async () => {
  const reports = reporter();
  logs.length = 0;
  await reportSecurityFailure({ route: 'monitoring-health', reason: 'authentication_failed', status: 401,
    reporter: reports, logger, headers: { authorization: secret }, email: 'private@example.com', url: secret });
  assert.deepEqual(reports.sequence, ['capture', 'flush']);
  assert.deepEqual(reports.events, [{ route: 'monitoring-health', reason: 'authentication_failed', status: 401, duration_ms: 0 }]);
  assert.ok(!JSON.stringify({ logs, events: reports.events }).includes(secret));
  for (const [route, reason, status] of [['evil-path', 'authentication_failed', 401], ['newsletter-worker', secret, 401],
    ['newsletter-worker', 'authentication_failed', 500], ['newsletter-offer', 'authentication_failed', 401]]) {
    assert.equal(isSecurityEvent(route, reason, status), false);
    await reportSecurityFailure({ route, reason, status, reporter: reports, logger });
  }
  assert.equal(reports.events.length, 1);
});

test('real Sentry transport accepts security events and strips secrets with distinct environment grouping', async () => {
  const envelopes = [];
  const reports = createSentryReporter({ env: { SENTRY_ENABLED: 'true', SENTRY_ENVIRONMENT: 'production',
    SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/1' },
  sdk: { ...Sentry, makeNodeTransport: () => ({ async send(envelope) { envelopes.push(envelope); return { statusCode: 200 }; }, async flush() { return true; } }) } });
  assert.ok(reports.capture({ route: 'newsletter-webhook', reason: 'webhook_rejected', status: 401, duration_ms: 0,
    error: secret, headers: { authorization: secret }, user: { email: 'private@example.com' } }));
  assert.equal(await reports.flush(), true);
  const events = envelopes.flatMap(x => x[1]).filter(x => x[0].type === 'event').map(x => x[1]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].fingerprint, ['security', 'production', 'newsletter-webhook', 'webhook_rejected']);
  assert.equal(events[0].tags.monitoring, 'security');
  assert.ok(!JSON.stringify(events).includes(secret)); assert.ok(!JSON.stringify(events).includes('private@example.com'));
  const source = { tags: events[0].tags, environment: 'preview' };
  assert.notDeepEqual(sanitizeMonitoringEvent(source).fingerprint, events[0].fingerprint);
  assert.equal(sanitizeMonitoringEvent({ ...source, tags: { ...source.tags, monitoring: 'request_capture' } }), null);
});

test('health authentication rejection emits one event without reading any dependency', async () => {
  const reports = reporter(), res = response();
  const handler = createHealthHandler({ env: { MONITORING_SECRET: secret }, reporter: reports,
    db: { from() { assert.fail('No database reads'); } }, graphql() { assert.fail('No Shopify reads'); } });
  await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
  assert.equal(res.code, 401); assert.equal(reports.events.length, 1); assert.equal(reports.events[0].route, 'monitoring-health');
  assert.deepEqual(res.body, { status: 'unauthorized' });
});

test('worker rejects invalid credentials without claiming jobs; missing configuration is not an attack event', async () => {
  for (const configured of [true, false]) {
    const reports = reporter(), res = response();
    await createNewsletterProcessHandler({ env: { ...env, CRON_SECRET: configured ? secret : '' }, reporter: reports,
      store: new Proxy({}, { get() { assert.fail('No worker activity'); } }), graphql() { assert.fail('No Shopify calls'); } })({
      method: 'POST', headers: { authorization: 'Bearer wrong' } }, res);
    assert.equal(res.code, configured ? 401 : 503); assert.equal(reports.events.length, configured ? 1 : 0);
    if (configured) assert.equal(reports.events[0].route, 'newsletter-worker');
  }
});

test('invalid webhook signatures report one rejection and never enqueue customer data', async () => {
  const reports = reporter(), res = response();
  const req = Readable.from([JSON.stringify({ email: 'private@example.com' })]);
  req.method = 'POST'; req.headers = { 'x-shopify-shop-domain': 'test-shop.myshopify.com',
    'x-shopify-topic': 'customers/create', 'x-shopify-hmac-sha256': 'invalid' };
  await createNewsletterWebhookHandler({ env, reporter: reports, store: { enqueue() { assert.fail('No write'); } } })(req, res);
  assert.equal(res.code, 401); assert.equal(reports.events.length, 1);
  assert.equal(reports.events[0].reason, 'webhook_rejected');
  assert.ok(!JSON.stringify(reports.events).includes('private@example.com'));
});

test('offer rate limit reports an abuse indicator while preserving 429, retry header and no Shopify calls', async () => {
  const reports = reporter(), res = response();
  await createNewsletterOfferHandler({ env, reporter: reports, store: { async allowStatus() { return false; } },
    graphql() { assert.fail('No Shopify requests'); } })({ method: 'POST',
    headers: { origin: 'https://shop.example', 'content-type': 'application/json', 'x-vercel-forwarded-for': '192.0.2.1' },
    body: { token: 'a'.repeat(64) } }, res);
  assert.equal(res.code, 429); assert.equal(res.headers['Retry-After'], '60');
  assert.deepEqual(res.body, { status: 'pending' }); assert.equal(reports.events[0].reason, 'rate_limit_reached');
  assert.ok(!JSON.stringify(reports.events).includes('192.0.2.1'));
});

test('OAuth 401 is reported but raw provider errors and query tokens never reach logs or events', async () => {
  for (const status of [401, 500, 200]) {
    logs.length = 0;
    const reports = reporter(), res = response();
    await createShopifyCallbackHandler({ reporter: reports, logger, completeAuthorization: async () => {
      if (status !== 200) throw Object.assign(new Error(secret), { statusCode: status });
    } })({ method: 'GET', query: { code: secret } }, res);
    assert.equal(res.code, status); assert.equal(reports.events.length, status === 401 ? 1 : 0);
    assert.ok(!JSON.stringify({ logs, events: reports.events, body: res.body }).includes(secret));
  }
});

test('failed reporting never changes the authentication response or permits a worker run', async () => {
  const res = response();
  const handler = createNewsletterProcessHandler({ env, reporter: { capture() { throw new Error(secret); } },
    store: { claim() { assert.fail('No write'); } }, graphql() { assert.fail('No query'); } });
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 401); assert.deepEqual(res.body, { error: 'Unauthorized.' });
  await reportSecurityFailure({ route: 'newsletter-worker', reason: 'authentication_failed', status: 401,
    reporter: { capture() {}, async flush() { throw new Error(secret); } }, logger: { warn() { throw new Error(secret); } } });
});

test('ordinary CORS, validation and method errors do not become authentication alerts', async () => {
  const reports = reporter();
  for (const [method, origin, expected] of [['POST', 'https://other.example', 403], ['GET', 'https://shop.example', 405]]) {
    const res = response();
    await createNewsletterOfferHandler({ env, reporter: reports, store: {}, graphql() { assert.fail('No query'); } })({
      method, headers: { origin } }, res);
    assert.equal(res.code, expected);
  }
  const res = response();
  await createShopifyCallbackHandler({ reporter: reports, logger, completeAuthorization() { assert.fail('No exchange'); } })({ method: 'POST' }, res);
  assert.equal(res.code, 405); assert.deepEqual(reports.events, []);
});

test('missing or empty admin configuration cannot make an anonymous request an administrator', () => {
  for (const [header, configured] of [[undefined, undefined], ['', ''], [undefined, secret], [secret, undefined],
    ['wrong', secret], [[secret], secret]]) assert.equal(hasProjectAdminAccess(header, configured), false);
  assert.equal(hasProjectAdminAccess(secret, secret), true);
});

test('security event budget limits a warm-process flood without suppressing ordinary failure monitoring', () => {
  let time = 0, captured = 0;
  const reports = createSentryReporter({ env: { SENTRY_ENABLED: 'true', SENTRY_DSN: 'configured' }, now: () => time,
    sdk: { NodeClient: class { init() {} captureEvent() { captured++; return 'id'; } } } });
  const event = { route: 'monitoring-health', reason: 'authentication_failed', status: 401, duration_ms: 0 };
  for (let n = 0; n < 100; n++) reports.capture(event);
  assert.equal(captured, 20);
  assert.equal(reports.capture({ ...event, route: 'newsletter-worker' }), 'id');
  assert.equal(reports.capture({ route: 'becoming-access', reason: 'server_error', status: 503, duration_ms: 0 }), 'id');
  time = 300000;
  assert.equal(reports.capture(event), 'id');
  assert.equal(captured, 23);
});
