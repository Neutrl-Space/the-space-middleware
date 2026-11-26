import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProductPages, serveProductPagesCheck } from '../lib/product-pages-check.js';
import { createHealthHandler } from '../lib/monitoring.js';

const product = (n, overrides = {}) => ({ id: `gid://shopify/Product/${n}`, handle: `piece-${n}`,
  status: 'ACTIVE', onlineStoreUrl: `https://neutrlspaceny.com/products/piece-${n}`, ...overrides });
const page = (nodes, cursor = null) => ({ products: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } } });
const signal = () => AbortSignal.timeout(1000);
const response = (status = 200, location = null) => ({ status, headers: { get: name => name === 'location' ? location : null },
  body: { async cancel() {} } });

test('discovers all published product pages across catalog pages and never sends app credentials', async () => {
  const requested = [], queries = [];
  const result = await checkProductPages({ signal: signal(), graphql: async (query, args) => {
    queries.push(query); assert.doesNotMatch(query, /mutation|customers|orders/);
    return args.after ? page([product(4)]) : page([product(1), product(2, { status: 'DRAFT' }), product(3, { onlineStoreUrl: null })], 'next');
  }, fetchImpl: async (url, options) => {
    requested.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers, undefined);
    assert.ok(options.signal instanceof AbortSignal); return response();
  } });
  assert.equal(queries.length, 2); assert.equal(result.productsChecked, 2); assert.equal(result.status, 'ok');
  assert.deepEqual(requested.sort(), ['https://neutrlspaceny.com/products/piece-1', 'https://neutrlspaceny.com/products/piece-4']);
});

test('a 404 or transport failure reports the affected handle without error bodies', async () => {
  const result = await checkProductPages({ signal: signal(), graphql: async () => page([product(1), product(2), product(3)]),
    fetchImpl: async url => { if (url.endsWith('piece-3')) throw new Error('private token'); return response(url.endsWith('piece-2') ? 404 : 200); } });
  assert.equal(result.status, 'degraded'); assert.equal(result.productsChecked, 3); assert.equal(result.failedCount, 2);
  assert.deepEqual(result.failures, [{ handle: 'piece-2', status: 'down', httpStatus: 404 }, { handle: 'piece-3', status: 'down', httpStatus: 0 }]);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('redirects cannot turn an unavailable product into a healthy homepage or contact an external host', async () => {
  for (const location of ['https://example.com/products/piece-1', '/', '/products/other', 'http://neutrlspaceny.com/products/piece-1']) {
    let count = 0;
    const result = await checkProductPages({ signal: signal(), graphql: async () => page([product(1)]),
      fetchImpl: async () => { count++; return response(302, location); } });
    assert.equal(count, 1); assert.equal(result.status, 'degraded');
  }
  let count = 0;
  const result = await checkProductPages({ signal: signal(), graphql: async () => page([product(1)]),
    fetchImpl: async () => ++count === 1 ? response(301, 'https://www.neutrlspaceny.com/products/piece-1') : response() });
  assert.equal(result.status, 'ok'); assert.equal(count, 2);
});

test('malformed, empty, repeated and externally hosted catalogs cannot return green or trigger external requests', async () => {
  for (const graphql of [async () => ({}), async () => page([]), async () => page([], 'same'),
    async () => page([product(1, { onlineStoreUrl: 'https://example.com/products/piece-1' })]),
    async () => page([product(1), product(1)])]) {
    await assert.rejects(checkProductPages({ signal: signal(), graphql, fetchImpl: () => assert.fail('No fetch before catalog validation') }));
  }
});

test('concurrency is capped at three and every page is checked', async () => {
  let active = 0, max = 0, calls = 0;
  const result = await checkProductPages({ signal: signal(), graphql: async () => page(Array.from({ length: 8 }, (_, n) => product(n + 1))),
    fetchImpl: async () => { calls++; active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return response(); } });
  assert.equal(calls, 8); assert.equal(result.productsChecked, 8); assert.equal(max, 3);
});

test('timeouts and upstream catalog exceptions fail without exposing raw messages or partial success', async () => {
  for (const graphql of [async () => { throw new Error('private secret'); }, () => new Promise(() => {})]) {
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await serveProductPagesCheck({ graphql, res, timeoutMs: 10 });
    assert.equal(res.code, 503); assert.deepEqual(res.body, { status: 'check_failed' });
  }
});

test('combined catalog check remains behind monitoring authentication', async () => {
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await createHealthHandler({ env: { MONITORING_SECRET: 'test-monitoring-secret-at-least-32-characters' },
    db: { from() { assert.fail('No database reads'); } }, graphql() { assert.fail('No Shopify reads'); } })({
    method: 'GET', query: { check: 'products' }, headers: { authorization: 'Bearer wrong' } }, res);
  assert.equal(res.code, 401);
});
