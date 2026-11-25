import crypto from 'node:crypto';
import { servePreorderCheck } from './preorder-check.js';

function authorized(header, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof header !== 'string') return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

// Dependency readiness, not a claim that a real form submission or email was delivered.
// Only read existing records. Never write a customer, request, entry or consent flag.
export function createHealthHandler({ db, graphql, reporter, env = process.env, timeoutMs = 8000 }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const sentryTest = req.method === 'POST' && req.query?.test === 'sentry' && env.VERCEL_ENV === 'preview';
    if (req.method !== 'GET' && !sentryTest) {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ status: 'method_not_allowed' });
    }
    if (!env.MONITORING_SECRET || env.MONITORING_SECRET.length < 32) {
      return res.status(503).json({ status: 'not_configured' });
    }
    if (!authorized(req.headers?.authorization, env.MONITORING_SECRET)) {
      return res.status(401).json({ status: 'unauthorized' });
    }
    if (req.method === 'GET' && req.query?.check === 'preorders') {
      return servePreorderCheck({ graphql, reporter, res });
    }
    if (sentryTest) {
      if (env.SENTRY_ENABLED !== 'true' || !env.SENTRY_DSN || !reporter ||
          (env.SENTRY_ENVIRONMENT && env.SENTRY_ENVIRONMENT !== 'preview')) {
        return res.status(503).json({ status: 'sentry_test_not_configured' });
      }
      // Exercise the same failure wrapper as real forms, without running their business logic.
      // A distinct endpoint/reason grouping creates a new issue for the preview alert test.
      return withRequestMonitoring(async (_, out) => out.status(503).json({
        status: 'synthetic_failure', test: true,
      }), 'monitoring-test', { reporter })(req, res);
    }
    const signal = AbortSignal.timeout(timeoutMs);
    async function check(probe) {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(probe),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), timeoutMs); }),
        ]);
        return 'ok';
      } catch {
        // Upstream errors can contain tokens, customer data or SQL details.
        return 'failed';
      } finally { clearTimeout(timer); }
    }
    const read = (table) => async () => {
      const result = await db.from(table).select('id').limit(1).abortSignal(signal);
      if (result.error || !Array.isArray(result.data)) throw new Error('Read failed');
    };
    const names = ['request_storage', 'raffle_storage', 'shopify'];
    const values = await Promise.all([
      check(read('becoming_access_submissions')),
      check(read('raffle_entries')),
      check(async () => {
        const result = await graphql('query MonitoringShop { shop { id } }', {}, { signal });
        if (!result?.shop?.id) throw new Error('Shop unavailable');
      }),
    ]);
    const checks = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    const healthy = values.every((value) => value === 'ok');
    return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
  };
}

// One structured event per failed request, without body, URL query, headers or error text.
export function withRequestMonitoring(handler, route, { logger = console, now = Date.now, reporter } = {}) {
  return async (req, res) => {
    const started = now();
    let reported = false;
    let drained;
    function report(reason, statusCode) {
      if (reported) return;
      reported = true;
      const event = { event: 'request_capture_failure', route, reason,
        status: statusCode, duration_ms: Math.max(0, now() - started) };
      try { logger.error(JSON.stringify(event)); } catch { /* Reporting cannot break capture. */ }
      try { reporter?.capture(event); } catch { /* Reporting cannot break capture. */ }
    }
    function flush() {
      if (!reported || !reporter) return Promise.resolve();
      drained ||= Promise.resolve().then(() => reporter.flush()).catch(() => {});
      return drained;
    }
    res.once('finish', () => {
      if (res.statusCode >= 500) report('server_error', res.statusCode);
    });
    res.once('close', () => {
      if (!res.writableFinished) { report('connection_closed', 499); void flush(); }
    });
    const json = res.json;
    res.json = function (body) {
      if (res.statusCode >= 500) report('server_error', res.statusCode);
      if (body?.success === true && body.consentSynced === false) report('shopify_sync_deferred', res.statusCode);
      // Vercel may freeze after the response. Drain failure events before sending JSON.
      if (reported && reporter) return flush().then(() => json.call(this, body));
      return json.call(this, body);
    };
    try { return await handler(req, res); }
    catch (error) { report('unhandled_exception', 500); await flush(); throw error; }
    finally { await flush(); }
  };
}
