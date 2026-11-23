import { createProbeShopifyGraphql } from '../lib/probe-shopify.js';
import { createClient } from '@supabase/supabase-js';
import { probeConfig, runRequestCaptureProbe } from '../lib/request-capture-probe.js';
import { runProbeCommand } from '../lib/probe-runner.js';
import { sentryReporter } from '../lib/sentry.js';

// Deliberately do not load .env: production credentials must never become defaults.
process.exitCode = await runProbeCommand({ env: process.env, reporter: sentryReporter, run: async onStage => {
  const config = probeConfig(process.env);
  const db = createClient(config.url, process.env.PROBE_SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) },
  });
  const graphql = createProbeShopifyGraphql({ shop: config.shop,
    clientId: process.env.PROBE_SHOPIFY_CLIENT_ID, clientSecret: process.env.PROBE_SHOPIFY_CLIENT_SECRET });
  return runRequestCaptureProbe({ env: process.env, db, graphql, onStage });
} });
