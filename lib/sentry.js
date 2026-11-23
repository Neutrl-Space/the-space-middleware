import * as Sentry from '@sentry/node';

const ROUTES = new Set(['becoming-access', 'raffle', 'monitoring-test']);
const REASONS = new Set(['server_error', 'connection_closed', 'shopify_sync_deferred', 'unhandled_exception', 'verification']);
const ENVIRONMENTS = new Set(['development', 'preview', 'production', 'staging', 'test']);

// Rebuild from an allowlist after SDK processing, rather than trying to redact arbitrary payloads.
// No exception text, stack locals, request, user, headers, breadcrumbs or inherited scope survives.
export function sanitizeMonitoringEvent(event) {
  const route = event.tags?.route, reason = event.tags?.reason;
  if (event.tags?.monitoring !== 'request_capture' || !ROUTES.has(route) || !REASONS.has(reason)) return null;
  const status = Number(event.tags.status), duration = Number(event.contexts?.monitoring?.duration_ms);
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: 'node',
    environment: ENVIRONMENTS.has(event.environment) ? event.environment : 'development',
    ...(typeof event.release === 'string' && /^[a-f0-9]{40}$/i.test(event.release) ? { release: event.release } : {}),
    level: 'error',
    message: `Request capture: ${route} / ${reason}`,
    fingerprint: ['request-capture', route, reason],
    tags: { monitoring: 'request_capture', route, reason,
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'unknown' },
    contexts: { monitoring: { duration_ms: Number.isFinite(duration) ? Math.max(0, Math.min(duration, 3600000)) : 0 } },
  };
}

export function createSentryReporter({ sdk = Sentry, env = process.env } = {}) {
  let client;
  function getClient() {
    if (env.SENTRY_ENABLED !== 'true' || !env.SENTRY_DSN) return null;
    if (!client) {
      const environment = env.SENTRY_ENVIRONMENT || env.VERCEL_ENV || 'development';
      // A dedicated manual client: no global hooks, automatic integrations, tracing or profiling.
      client = new sdk.NodeClient({
        dsn: env.SENTRY_DSN,
        environment: ENVIRONMENTS.has(environment) ? environment : 'development',
        release: /^[a-f0-9]{40}$/i.test(env.VERCEL_GIT_COMMIT_SHA || '') ? env.VERCEL_GIT_COMMIT_SHA : undefined,
        integrations: [], transport: sdk.makeNodeTransport, stackParser: sdk.defaultStackParser,
        sampleRate: 1, tracesSampleRate: 0, enableLogs: false, sendClientReports: false,
        dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [],
          urlQueryParams: false, graphQL: { document: false, variables: false },
          databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 },
        beforeSend: sanitizeMonitoringEvent,
      });
      client.init();
    }
    return client;
  }
  return {
    capture(event) {
      try {
        if (!ROUTES.has(event.route) || !REASONS.has(event.reason)) return null;
        return getClient()?.captureEvent({ message: 'Request capture failure', level: 'error',
          tags: { monitoring: 'request_capture', route: event.route, reason: event.reason, status: String(event.status) },
          contexts: { monitoring: { duration_ms: event.duration_ms } } }) || null;
      } catch { return null; }
    },
    async flush() {
      try { return client ? await client.flush(1500) : false; } catch { return false; }
    },
  };
}

export const sentryReporter = createSentryReporter();
