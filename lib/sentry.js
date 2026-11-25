import * as Sentry from '@sentry/node';
import { isSecurityEvent } from './security-monitoring.js';

const ROUTES = new Set(['becoming-access', 'raffle', 'monitoring-test', 'daily-request-capture']);
const REASONS = new Set(['server_error', 'connection_closed', 'shopify_sync_deferred', 'unhandled_exception', 'verification', 'probe_failed']);
const ENVIRONMENTS = new Set(['development', 'preview', 'production', 'staging', 'test']);
const PREORDER_REASONS = new Set(['configuration_invalid', 'check_failed']);

function monitoringKind(route, reason, status) {
  if (isSecurityEvent(route, reason, Number(status))) return 'security';
  if (route === 'daily-preorder' && PREORDER_REASONS.has(reason)) return 'preorder';
  return ROUTES.has(route) && REASONS.has(reason) ? 'request_capture' : null;
}

// Rebuild from an allowlist after SDK processing, rather than trying to redact arbitrary payloads.
// No exception text, stack locals, request, user, headers, breadcrumbs or inherited scope survives.
export function sanitizeMonitoringEvent(event) {
  const route = event.tags?.route, reason = event.tags?.reason;
  const kind = monitoringKind(route, reason, event.tags?.status);
  if (!kind || event.tags?.monitoring !== kind) return null;
  const status = Number(event.tags.status), duration = Number(event.contexts?.monitoring?.duration_ms);
  const environment = ENVIRONMENTS.has(event.environment) ? event.environment : 'development';
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: 'node',
    environment,
    ...(typeof event.release === 'string' && /^[a-f0-9]{40}$/i.test(event.release) ? { release: event.release } : {}),
    level: 'error',
    message: `${kind === 'security' ? 'Security signal' : kind === 'preorder' ? 'Preorder check' : 'Request capture'}: ${route} / ${reason}`,
    fingerprint: [kind === 'request_capture' ? 'request-capture' : kind, environment, route, reason],
    tags: { monitoring: kind, route, reason,
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'unknown' },
    contexts: { monitoring: { duration_ms: Number.isFinite(duration) ? Math.max(0, Math.min(duration, 3600000)) : 0 } },
  };
}

export function createSentryReporter({ sdk = Sentry, env = process.env, now = Date.now } = {}) {
  let client;
  // Retain enough signals for a 10-in-5-minutes alert without sending every
  // rejected request during a flood. This budget is per warm process, not global.
  const securityWindows = new Map();
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
        const kind = monitoringKind(event.route, event.reason, event.status);
        if (!kind) return null;
        if (kind === 'security') {
          const time = now();
          let window = securityWindows.get(event.route);
          if (!window || time - window.started >= 300000 || time < window.started) {
            window = { started: time, sent: 0 };
            securityWindows.set(event.route, window);
          }
          if (window.sent >= 20) return null;
          window.sent++;
        }
        return getClient()?.captureEvent({ message: 'Request capture failure', level: 'error',
          tags: { monitoring: kind, route: event.route, reason: event.reason, status: String(event.status) },
          contexts: { monitoring: { duration_ms: event.duration_ms } } }) || null;
      } catch { return null; }
    },
    async flush() {
      try { return client ? await client.flush(1500) : false; } catch { return false; }
    },
  };
}

export const sentryReporter = createSentryReporter();
