import { ProbeCheckError } from './probe-errors.js';
import { ProbeConfigurationError } from './request-capture-probe.js';

// The run callback owns database/Shopify client creation. Alert verification never calls it.
export async function runProbeCommand({ env, run, reporter, logger = console, now = Date.now }) {
  let stage = 'configuration';
  const started = now();
  const verification = env.PROBE_ALERT_TEST === 'true';
  try {
    if (verification) {
      if (env.SENTRY_ENABLED !== 'true' || !env.SENTRY_DSN) {
        throw new ProbeConfigurationError('Alert verification requires SENTRY_ENABLED=true and SENTRY_DSN.');
      }
      throw new ProbeCheckError('Intentional monitoring alert test. No submissions were made.');
    }
    const result = await run(value => { stage = value; logger.log(`Checking: ${stage}`); });
    logger.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    logger.error(error instanceof ProbeConfigurationError || error instanceof ProbeCheckError
      ? error.message
      : `Request capture probe failed during ${stage}. Check the isolated test services and configuration.`);
    try {
      const id = reporter.capture({ route: 'daily-request-capture', reason: verification ? 'verification' : 'probe_failed',
        status: 500, duration_ms: Math.max(0, now() - started) });
      const flushed = await reporter.flush();
      logger.error(id && flushed
        ? 'Failure event flushed to Sentry. Confirm email/Slack delivery separately.'
        : 'Sentry delivery was not confirmed. Check the monitoring-test SENTRY_DSN secret and GitHub failure notifications.');
    } catch {
      logger.error('Sentry delivery failed. The workflow still reports failure.');
    }
    return 1;
  }
}
