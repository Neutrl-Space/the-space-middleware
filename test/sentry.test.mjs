import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as Sentry from '@sentry/node';
import { createSentryReporter, sanitizeMonitoringEvent } from '../lib/sentry.js';
import { withRequestMonitoring } from '../lib/monitoring.js';

const dsn = 'https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/1';
const event = { route: 'becoming-access', reason: 'server_error', status: 503, duration_ms: 12 };

test('Sentry stays off until both the explicit toggle and DSN are present', async () => {
  for (const env of [{}, { SENTRY_DSN: dsn }, { SENTRY_ENABLED: 'true' }]) {
    const reporter = createSentryReporter({ env, sdk: { NodeClient() { throw new Error('Must not initialize'); } } });
    assert.equal(reporter.capture(event), null); assert.equal(await reporter.flush(), false);
  }
});

test('reporting fails open when SDK initialization or transport fails', async () => {
  const reporter = createSentryReporter({ env: { SENTRY_ENABLED: 'true', SENTRY_DSN: dsn },
    sdk: { NodeClient: class { constructor() { throw new Error('Unavailable'); } } } });
  assert.equal(reporter.capture(event), null); assert.equal(await reporter.flush(), false);
});

test('the final filter drops raw errors, request data and arbitrary inherited scope', () => {
  const safe = sanitizeMonitoringEvent({ event_id: 'event-id', timestamp: 1, environment: 'preview',
    message: 'secret customer@example.com', exception: { values: [{ value: 'secret' }] },
    user: { email: 'customer@example.com' }, request: { headers: { Authorization: 'secret' }, data: 'secret' },
    server_name: 'private-host', breadcrumbs: [{ message: 'secret' }], extra: { name: 'Private Person' },
    contexts: { monitoring: { duration_ms: 10, secret: 'secret' }, trace: { private: 'secret' } },
    tags: { monitoring: 'request_capture', route: 'raffle', reason: 'unhandled_exception', status: '500', private: 'secret' },
  });
  assert.equal(safe.message, 'Request capture: raffle / unhandled_exception');
  assert.deepEqual(safe.contexts, { monitoring: { duration_ms: 10 } });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(JSON.stringify(safe).includes('Private'), false);
  assert.equal(JSON.stringify(safe).includes('customer@'), false);
  assert.equal(sanitizeMonitoringEvent({ message: 'unapproved automatic error' }), null);
});

test('real SDK transport receives only the approved event, grouped by endpoint and reason', async () => {
  const envelopes = [];
  const reporter = createSentryReporter({ env: { SENTRY_ENABLED: 'true', SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'preview' },
    sdk: { ...Sentry, makeNodeTransport: () => ({
      async send(envelope) { envelopes.push(envelope); return { statusCode: 200 }; },
      async flush() { return true; },
    }) } });
  assert.ok(reporter.capture({ ...event, email: 'private@example.com', error: 'secret', body: { password: 'secret' } }));
  assert.equal(await reporter.flush(), true);
  const payloads = envelopes.flatMap(envelope => envelope[1]).filter(item => item[0].type === 'event').map(item => item[1]);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].environment, 'preview');
  assert.deepEqual(payloads[0].fingerprint, ['request-capture', 'becoming-access', 'server_error']);
  assert.equal(JSON.stringify(payloads).includes('secret'), false);
  assert.equal(JSON.stringify(payloads).includes('private@'), false);
  assert.equal(payloads[0].request, undefined);
});

function response(order) {
  const res = new EventEmitter();
  return Object.assign(res, { statusCode: 200, setHeader() {},
    status(value) { this.statusCode = value; return this; },
    json(body) { order.push('response'); this.body = body; this.writableFinished = true; this.emit('finish'); return this; },
  });
}

test('handled failures are captured and flushed once before the serverless JSON response', async () => {
  for (const deferred of [false, true]) {
    const order = [], reports = [], res = response(order);
    const reporter = { capture(event) { reports.push(event); order.push('capture'); }, async flush() { order.push('flush'); } };
    const body = deferred ? { success: true, consentSynced: false } : { error: 'Private upstream details' };
    await withRequestMonitoring(async (_, out) => out.status(deferred ? 200 : 503).json(body), 'becoming-access', {
      reporter, logger: { error() {} },
    })({ body: { email: 'private@example.com' } }, res);
    assert.deepEqual(order, ['capture', 'flush', 'response']);
    assert.equal(reports.length, 1); assert.equal(reports[0].reason, deferred ? 'shopify_sync_deferred' : 'server_error');
    assert.equal(JSON.stringify(reports).includes('private@'), false); assert.equal(res.body, body);
  }
});

test('SDK errors cannot change form response or replace the original thrown error', async () => {
  const order = [], reporter = { capture() { throw new Error('Sentry unavailable'); }, async flush() { throw new Error('Sentry unavailable'); } };
  const res = response(order), original = new Error('Original failure');
  const options = { reporter, logger: { error() { throw new Error('Logger unavailable'); } } };
  await withRequestMonitoring(async (_, out) => out.status(503).json({ error: 'Original response' }), 'raffle', options)({}, res);
  assert.equal(res.body.error, 'Original response'); assert.equal(res.statusCode, 503);
  await assert.rejects(withRequestMonitoring(async () => { throw original; }, 'raffle', options)({}, response([])), error => error === original);
});

test('successful and rejected-validation requests do not initialize or flush Sentry', async () => {
  for (const status of [200, 400, 403]) {
    const calls = [], res = response([]);
    await withRequestMonitoring(async (_, out) => out.status(status).json({ success: status === 200 }), 'raffle', {
      reporter: { capture() { calls.push('capture'); }, async flush() { calls.push('flush'); } }, logger: { error() {} },
    })({}, res);
    assert.deepEqual(calls, []);
  }
});
