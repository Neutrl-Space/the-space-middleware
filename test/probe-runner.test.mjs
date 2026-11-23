import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbeCommand } from '../lib/probe-runner.js';
import { sanitizeMonitoringEvent } from '../lib/sentry.js';
function fixture() {
  const events = [], logs = [];
  return { events, logs, logger: { log: s => logs.push(s), error: s => logs.push(s) },
    reporter: { capture: event => { events.push(event); return 'event'; }, flush: async () => true } };
}
test('alert verification reports a distinct failure without constructing clients or submitting forms', async () => {
  const f = fixture();
  const code = await runProbeCommand({ ...f, env: { PROBE_ALERT_TEST: 'true', SENTRY_ENABLED: 'true', SENTRY_DSN: 'configured' }, run: () => assert.fail('No clients or submissions allowed') });
  assert.equal(code, 1);
  assert.equal(f.events[0].route, 'daily-request-capture');
  assert.equal(f.events[0].reason, 'verification');
});
test('successful probes send no Sentry errors; real failures exclude exception and customer data', async () => {
  const f = fixture();
  assert.equal(await runProbeCommand({ ...f, env: {}, run: async () => ({ status: 'ok' }) }), 0);
  assert.equal(f.events.length, 0);
  assert.equal(await runProbeCommand({ ...f, env: {}, run: async () => { throw new Error('private@example.com secret'); } }), 1);
  assert.equal(f.events[0].reason, 'probe_failed');
  assert(!JSON.stringify(f.logs).includes('private@example.com'));
  const event = sanitizeMonitoringEvent({ tags: { monitoring: 'request_capture', ...f.events[0] }, environment: 'preview' });
  assert.equal(event.tags.route, 'daily-request-capture');
  assert.equal(event.tags.reason, 'probe_failed');
  assert(!JSON.stringify(event).includes('private@example.com'));
});
test('reporter failure cannot turn a failed probe into success', async () => {
  const f = fixture();
  f.reporter.capture = () => { throw new Error('private transport detail'); };
  assert.equal(await runProbeCommand({ ...f, env: {}, run: async () => { throw new Error('failed'); } }), 1);
  assert(!JSON.stringify(f.logs).includes('private transport detail'));
});
