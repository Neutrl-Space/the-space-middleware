import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkPreorders, servePreorderCheck } from '../lib/preorder-check.js';
import { createHealthHandler } from '../lib/monitoring.js';
import { runPreorderCheck } from '../scripts/check-preorders.mjs';
import { sanitizeMonitoringEvent } from '../lib/sentry.js';

const product = (id, overrides = {}) => ({ id: `gid://shopify/Product/${id}`, handle: `piece-${id}`, status: 'ACTIVE',
  preorder: { type: 'boolean', value: 'true' }, shipDate: { type: 'date', value: '2026-12-04' }, ...overrides });
const variant = (id, overrides = {}) => ({ id: `gid://shopify/ProductVariant/${id}`, inventoryPolicy: 'DENY',
  inventoryItem: { tracked: true }, ...overrides });
const connection = (nodes, cursor = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });
const secret = 'a-private-monitoring-secret-with-32-characters';
function response() {
  return Object.assign(new EventEmitter(), { statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } });
}

test('scans every product and variant page; ignores ordinary and archived products', async () => {
  const calls = [];
  const result = await checkPreorders({ graphql: async (query, args) => {
    calls.push({ query, args });
    assert.doesNotMatch(query, /mutation|customers|orders|inventoryQuantity/);
    if (query.includes('MonitoringPreorderProducts')) return { products: args.after
      ? connection([product(4)]) : connection([product(1, { preorder: null }), product(2, { status: 'ARCHIVED' }), product(3)], 'next-product') };
    return { product: { variants: args.id.endsWith('/3') && !args.after
      ? connection([variant(31)], 'next-variant') : connection([variant(args.id.endsWith('/3') ? 32 : 41)]) } };
  } });
  assert.deepEqual(result, { status: 'ok', productsScanned: 4, preorderProducts: 2, variantsChecked: 3,
    findingCount: 0, findings: [], findingsTruncated: false });
  assert.equal(calls.length, 5);
});

test('reports missing dates and both unsafe inventory settings on each affected variant', async () => {
  const result = await checkPreorders({ graphql: async query => query.includes('MonitoringPreorderProducts')
    ? { products: connection([product(1, { shipDate: null })]) }
    : { product: { variants: connection([variant(1, { inventoryPolicy: 'CONTINUE', inventoryItem: { tracked: false } })]) } } });
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.findings.map(x => x.code), ['missing_or_invalid_ship_date', 'inventory_not_tracked', 'continue_selling_enabled']);
});

test('requires real calendar dates but does not invent a future-date or positive-stock rule', async () => {
  for (const [value, expected] of [['2026-02-30', 'invalid'], ['2026-02-28', 'ok'], ['2026-12-04', 'ok']]) {
    const result = await checkPreorders({ graphql: async query => query.includes('MonitoringPreorderProducts')
      ? { products: connection([product(1, { shipDate: { type: 'date', value } })]) }
      : { product: { variants: connection([variant(1)]) } } });
    assert.equal(result.status, expected);
  }
});

test('malformed or incomplete data, pagination loops and scan limits cannot return success', async () => {
  const handlers = [
    async () => ({}),
    async () => ({ products: { nodes: [], pageInfo: {} } }),
    async () => ({ products: connection([], 'repeated') }),
    async query => query.includes('MonitoringPreorderProducts') ? { products: connection([product(1)]) } : { product: { variants: connection([]) } },
    async query => query.includes('MonitoringPreorderProducts') ? { products: connection([product(1)]) } : { product: { variants: connection([{ id: 'bad' }]) } },
  ];
  for (const graphql of handlers) await assert.rejects(checkPreorders({ graphql }));
  await assert.rejects(checkPreorders({ maxQueries: 0, graphql: () => assert.fail('No query allowed') }));
  await assert.rejects(checkPreorders({ signal: AbortSignal.abort(), graphql: () => assert.fail('No query allowed') }));
});

test('invalid flags are findings and long reports retain full counts with bounded details', async () => {
  const result = await checkPreorders({ graphql: async () => ({ products: connection(Array.from({ length: 120 }, (_, n) =>
    product(n + 1, { preorder: { type: 'single_line_text_field', value: 'yes' } }))) }) });
  assert.equal(result.status, 'invalid'); assert.equal(result.findingCount, 120);
  assert.equal(result.findings.length, 100); assert.equal(result.findingsTruncated, true);
});

test('audit is authenticated before any catalog read and never reads submission tables', async () => {
  let calls = 0;
  const handler = createHealthHandler({ db: { from() { assert.fail('No customer storage reads'); } },
    env: { MONITORING_SECRET: secret }, graphql: async () => { calls++; return { products: connection([]) }; } });
  const unauthorized = response();
  await handler({ method: 'GET', query: { check: 'preorders' }, headers: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401); assert.equal(calls, 0);
  const authorized = response();
  await handler({ method: 'GET', query: { check: 'preorders' }, headers: { authorization: `Bearer ${secret}` } }, authorized);
  assert.equal(authorized.statusCode, 200); assert.equal(calls, 1);
  assert.equal(authorized.headers['Cache-Control'], 'no-store');
});

test('unavailable and hung upstreams return redacted failures and flush the production alert', async () => {
  for (const graphql of [async () => { throw new Error('PRIVATE upstream token'); }, () => new Promise(() => {})]) {
    const res = response(), reports = [];
    await servePreorderCheck({ graphql, res, timeoutMs: 10,
      reporter: { capture(event) { reports.push(event); }, async flush() { reports.push('flushed'); } } });
    assert.equal(res.statusCode, 503); assert.deepEqual(res.body, { status: 'check_failed' });
    assert.equal(reports[0].route, 'daily-preorder'); assert.equal(reports[0].reason, 'check_failed');
    assert.equal(reports[1], 'flushed'); assert.ok(!JSON.stringify(res.body).includes('PRIVATE'));
  }
});

test('configuration problems send a distinct alert; healthy audits send none', async () => {
  for (const bad of [false, true]) {
    const res = response(), events = [];
    await servePreorderCheck({ res, graphql: async query => query.includes('MonitoringPreorderProducts')
      ? { products: connection([product(1, bad ? { shipDate: null } : {})]) }
      : { product: { variants: connection([variant(1)]) } },
    reporter: { capture(event) { events.push(event); }, async flush() {} } });
    assert.equal(res.statusCode, bad ? 503 : 200);
    assert.equal(events.length, bad ? 1 : 0);
    if (bad) assert.equal(events[0].reason, 'configuration_invalid');
  }
});

test('preorder Sentry events exclude arbitrary metadata and cannot mix with request capture', () => {
  const event = { environment: 'production', tags: { monitoring: 'preorder', route: 'daily-preorder', reason: 'configuration_invalid', status: '503' },
    user: { email: 'private@example.com' }, request: { headers: { authorization: secret } },
    contexts: { monitoring: { duration_ms: 100 }, catalog: { secret } } };
  const result = sanitizeMonitoringEvent(event);
  assert.deepEqual(result.fingerprint, ['preorder', 'production', 'daily-preorder', 'configuration_invalid']);
  assert.equal(result.tags.monitoring, 'preorder');
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('private@example.com'));
  assert.equal(sanitizeMonitoringEvent({ ...event, tags: { ...event.tags, monitoring: 'request_capture' } }), null);
});

test('CI reader reports verified findings, fails unavailable checks and never exposes raw bodies or errors', async () => {
  const base = { status: 'ok', productsScanned: 1, preorderProducts: 1, variantsChecked: 1, findingCount: 0, findings: [], findingsTruncated: false };
  for (const [body, status, expected] of [[base, 200, 0], [{ ...base, status: 'invalid', findingCount: 1,
    findings: [{ productId: 'gid://shopify/Product/1', code: 'missing_or_invalid_ship_date' }] }, 503, 1],
  [{ ...base, productsScanned: undefined }, 200, 1], [{ status: 'check_failed', token: secret }, 503, 1], [base, 401, 1]]) {
    const logs = [];
    const code = await runPreorderCheck({ env: { GITHUB_REF: 'refs/heads/main', MONITORING_SECRET: secret },
      logger: { log: x => logs.push(x), error: x => logs.push(x) }, fetchImpl: async (url, options) => {
        assert.equal(url, 'https://the-space-middleware.vercel.app/api/health?check=preorders');
        assert.equal(options.headers.Authorization, `Bearer ${secret}`); assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        return { ok: status === 200, status, json: async () => body };
      } });
    assert.equal(code, expected); assert.ok(!logs.join('').includes(secret));
  }
  for (const env of [{}, { GITHUB_REF: 'refs/heads/feature', MONITORING_SECRET: secret }]) {
    assert.equal(await runPreorderCheck({ env, logger: { error() {} }, fetchImpl: () => assert.fail('No request') }), 1);
  }
  const logs = [];
  assert.equal(await runPreorderCheck({ env: { GITHUB_REF: 'refs/heads/main', MONITORING_SECRET: secret },
    logger: { error: x => logs.push(x) }, fetchImpl: async () => { throw new Error(secret); } }), 1);
  assert.ok(!logs.join('').includes(secret));
});
