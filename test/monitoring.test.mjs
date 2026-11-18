import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHealthHandler, withRequestMonitoring } from '../lib/monitoring.js';

const secret = 'test-monitor-secret-with-at-least-32-characters';
function response() {
  const res = new EventEmitter();
  return Object.assign(res, { statusCode: 200, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; this.writableFinished = true; this.emit('finish'); return this; },
  });
}
function fixture({ failedTable, failedShopify, timeoutMs, hang = false, configuredSecret = secret } = {}) {
  const calls = [];
  const db = { from(table) {
    calls.push(table);
    return { select(column) {
      assert.equal(column, 'id');
      return { limit(count) {
        assert.equal(count, 1);
        return { abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal);
          if (hang) return new Promise(() => {});
          return { data: failedTable === table ? null : [], error: failedTable === table ? { message: 'PRIVATE SQL DETAIL' } : null };
        } };
      } };
    } };
  } };
  const graphql = async (query, variables, options) => {
    calls.push('shopify');
    assert.match(query, /query MonitoringShop/);
    assert.ok(options.signal instanceof AbortSignal);
    if (failedShopify) throw new Error('PRIVATE SHOP TOKEN');
    return { shop: { id: 'gid://shopify/Shop/1' } };
  };
  return { calls, handler: createHealthHandler({ db, graphql, env: { MONITORING_SECRET: configuredSecret }, timeoutMs }) };
}
const request = { method: 'GET', headers: { authorization: `Bearer ${secret}` } };

test('monitor is fail-closed and never probes dependencies without authorization', async () => {
  for (const configuredSecret of ['', 'short', secret]) {
    const f = fixture({ configuredSecret }), res = response();
    await f.handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    assert.equal(res.statusCode, configuredSecret === secret ? 401 : 503);
    assert.deepEqual(f.calls, []);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('only GET is supported; POST cannot create a synthetic customer or entry', async () => {
  const f = fixture(), res = response();
  await f.handler({ ...request, method: 'POST' }, res);
  assert.equal(res.statusCode, 405); assert.equal(res.headers.Allow, 'GET'); assert.deepEqual(f.calls, []);
});

test('empty accessible tables and Shopify connectivity are healthy without exposing record IDs', async () => {
  const f = fixture(), res = response(); await f.handler(request, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: 'ok', checks: { request_storage: 'ok', raffle_storage: 'ok', shopify: 'ok' } });
  assert.equal(JSON.stringify(res.body).includes('gid://'), false);
});

test('each dependency failure returns 503 and no upstream error details', async () => {
  for (const options of [{ failedTable: 'becoming_access_submissions' }, { failedTable: 'raffle_entries' }, { failedShopify: true }]) {
    const f = fixture(options), res = response(); await f.handler(request, res);
    assert.equal(res.statusCode, 503); assert.equal(res.body.status, 'degraded');
    assert.ok(Object.values(res.body.checks).includes('failed'));
    assert.equal(JSON.stringify(res.body).includes('PRIVATE'), false);
  }
});

test('a hung dependency cannot make the health check wait indefinitely', async () => {
  const f = fixture({ timeoutMs: 20, hang: true }), res = response();
  await f.handler(request, res); assert.equal(res.statusCode, 503);
});

test('5xx, aborted connections and thrown handlers emit one redacted capture event', async () => {
  for (const kind of ['5xx', 'abort', 'throw']) {
    const lines = [], res = response();
    const handler = withRequestMonitoring(async (_, out) => {
      if (kind === 'throw') throw new Error('secret customer@example.com');
      if (kind === 'abort') { out.emit('close'); return; }
      return out.status(503).json({ error: 'secret customer@example.com' });
    }, 'raffle', { logger: { error: (line) => lines.push(line) }, now: () => 100 });
    await handler({ body: { email: 'customer@example.com' }, headers: { authorization: 'secret' } }, res).catch(() => {});
    res.emit('close');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]); assert.equal(entry.event, 'request_capture_failure'); assert.equal(entry.route, 'raffle');
    assert.equal(lines[0].includes('secret'), false); assert.equal(lines[0].includes('customer@'), false);
  }
});

test('deferred Shopify sync is reported despite HTTP 200, without changing the customer response', async () => {
  const lines = [], res = response(), body = { success: true, consentSynced: false };
  await withRequestMonitoring(async (_, out) => out.json(body), 'becoming-access', {
    logger: { error: (line) => lines.push(JSON.parse(line)) },
  })({}, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body, body);
  assert.equal(lines[0].reason, 'shopify_sync_deferred');
});

test('successful requests and validation errors do not raise server-failure alerts', async () => {
  for (const status of [200, 400, 403, 415]) {
    const lines = [], res = response();
    await withRequestMonitoring(async (_, out) => out.status(status).json({ success: status === 200 }), 'raffle', {
      logger: { error: (line) => lines.push(line) },
    })({}, res);
    res.emit('close'); assert.deepEqual(lines, []);
  }
});
