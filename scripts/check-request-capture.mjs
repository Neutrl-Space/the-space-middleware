import { ProbeCheckError } from '../lib/probe-errors.js';
import { createProbeShopifyGraphql } from '../lib/probe-shopify.js';
import { createClient } from '@supabase/supabase-js';
import { ProbeConfigurationError, probeConfig, runRequestCaptureProbe } from '../lib/request-capture-probe.js';

// Deliberately do not load .env: production credentials must never become defaults.
let stage = 'configuration';
try {
  const config = probeConfig(process.env);
  const db = createClient(config.url, process.env.PROBE_SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) },
  });
  const graphql = createProbeShopifyGraphql({ shop: config.shop,
    clientId: process.env.PROBE_SHOPIFY_CLIENT_ID, clientSecret: process.env.PROBE_SHOPIFY_CLIENT_SECRET });
  console.log(JSON.stringify(await runRequestCaptureProbe({ env: process.env, db, graphql, onStage: value => { stage = value; console.log(`Checking: ${stage}`); } })));
} catch (error) {
  // Provider responses, tokens, synthetic customer IDs and submitted fields stay out of CI logs.
  console.error(error instanceof ProbeConfigurationError || error instanceof ProbeCheckError
    ? error.message
    : `Request capture probe failed during ${stage}. Check the isolated test services and configuration.`);
  process.exitCode = 1;
}
