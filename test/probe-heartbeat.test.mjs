import test from 'node:test';
import assert from 'node:assert/strict';
import { sendProbeHeartbeat } from '../scripts/send-probe-heartbeat.mjs';

const token = 'private_test_token';
const url = `https://incidents.betterstack.com/api/v1/heartbeat/${token}`;
const env = { GITHUB_REF: 'refs/heads/main', BETTERSTACK_HEARTBEAT_URL: url };

test('successful main check sends a bounded GET without following redirects', async () => {
  let cancelled = false;
  const result = await sendProbeHeartbeat({ env, logger: { log() {} }, fetchImpl: async (target, options) => {
    assert.equal(target, url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, body: { cancel: async () => { cancelled = true; } } };
  } });
  assert.equal(result, 0);
  assert.equal(cancelled, true);
});

test('branch and intentional alert tests never send a heartbeat', async () => {
  for (const overrides of [{ GITHUB_REF: 'refs/heads/monitoring-and-alerts' }, { PROBE_ALERT_TEST: 'true' }]) {
    assert.equal(await sendProbeHeartbeat({ env: { ...env, ...overrides }, logger: { log() {} },
      fetchImpl: () => assert.fail('Unexpected request') }), 0);
  }
});

test('missing or unsafe URLs fail without sending any request or exposing tokens', async () => {
  for (const value of [undefined, 'invalid', url + '/fail', url + '?token=secret',
    url.replace('https:', 'http:'), url.replace('incidents.betterstack.com', 'example.com')]) {
    const logs = [];
    assert.equal(await sendProbeHeartbeat({ env: { ...env, BETTERSTACK_HEARTBEAT_URL: value },
      logger: { error: value => logs.push(value) }, fetchImpl: () => assert.fail('Unexpected request') }), 1);
    assert.ok(!logs.join('').includes(token));
  }
});

test('rejected responses and network errors fail with redacted diagnostics', async () => {
  for (const fetchImpl of [async () => ({ ok: false }), async () => { throw new Error(url); }]) {
    const logs = [];
    assert.equal(await sendProbeHeartbeat({ env, fetchImpl, logger: { error: value => logs.push(value) } }), 1);
    assert.ok(!logs.join('').includes(token));
  }
});
