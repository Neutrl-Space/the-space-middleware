import { pathToFileURL } from 'node:url';

export async function sendProbeHeartbeat({ env = process.env, fetchImpl = fetch, logger = console } = {}) {
  // Branch checks and intentional alert tests must not reset the daily timer.
  if (env.GITHUB_REF !== 'refs/heads/main' || env.PROBE_ALERT_TEST === 'true') {
    logger.log('Heartbeat skipped outside a normal main-branch check.');
    return 0;
  }
  try {
    const url = new URL(env.BETTERSTACK_HEARTBEAT_URL);
    if (url.protocol !== 'https:' || url.hostname !== 'incidents.betterstack.com' ||
        url.port || url.username || url.password || url.search || url.hash ||
        !/^\/api\/v1\/heartbeat\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
      throw new Error('Invalid heartbeat URL');
    }
    const response = await fetchImpl(url.href, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Heartbeat rejected');
    logger.log('Daily submission check heartbeat delivered.');
    return 0;
  } catch {
    // URLs contain capability tokens; never print URLs, bodies or raw exceptions.
    logger.error('Heartbeat delivery failed. Check BETTERSTACK_HEARTBEAT_URL and Better Stack availability.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await sendProbeHeartbeat();
}
