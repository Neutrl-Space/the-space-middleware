import 'dotenv/config';
import { sentryReporter } from '../lib/sentry.js';

if (process.env.SENTRY_ENABLED !== 'true' || !process.env.SENTRY_DSN) {
  console.error('Set SENTRY_ENABLED=true and SENTRY_DSN in your local environment first.');
  process.exitCode = 1;
} else {
  const id = sentryReporter.capture({ route: 'monitoring-test', reason: 'verification', status: 500, duration_ms: 0 });
  const sent = await sentryReporter.flush();
  if (!id || !sent) {
    console.error('The test event was not confirmed as drained. Check the DSN, network and Sentry Issues.');
    process.exitCode = 1;
  } else {
    console.log(`Synthetic event queued and drained: ${id}. Verify it in Sentry Issues; alert delivery is a separate check.`);
  }
}
