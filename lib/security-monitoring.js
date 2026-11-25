// Fixed classifications only: never accept URLs, headers, IPs, signatures or error text.
const AUTH_ROUTES = new Set(['monitoring-health', 'shopify-oauth', 'newsletter-worker']);
export function isSecurityEvent(route, reason, status) {
  return (AUTH_ROUTES.has(route) && reason === 'authentication_failed' && status === 401) ||
    (route === 'newsletter-webhook' && reason === 'webhook_rejected' && status === 401) ||
    (route === 'newsletter-offer' && reason === 'rate_limit_reached' && status === 429);
}

export async function reportSecurityFailure({ route, reason, status, reporter, logger = console }) {
  if (!isSecurityEvent(route, reason, status)) return;
  const event = { route, reason, status, duration_ms: 0 };
  try { logger.warn(JSON.stringify({ event: 'security_signal', ...event })); } catch { /* Preserve authentication behavior. */ }
  try {
    reporter?.capture(event);
    await reporter?.flush();
  } catch { /* Monitoring must never grant access or change the rejection response. */ }
}
