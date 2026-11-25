import { ProbeCheckError } from './probe-errors.js';
import { randomUUID } from 'node:crypto';
import { createBecomingAccessHandler } from './becoming-access.js';
import { createRaffleHandler } from './raffle.js';

export const PROBE_SCHEMA = 'monitoring_test';
export class ProbeConfigurationError extends Error {}

// Use explicit probe credentials; the shared project is allowed, the public schema is not.
export function probeConfig(env) {
  const required = ['PROBE_SUPABASE_REF', 'PROBE_SUPABASE_SERVICE_KEY',
    'PROBE_SHOPIFY_SHOP', 'PROBE_SHOPIFY_CLIENT_ID', 'PROBE_SHOPIFY_CLIENT_SECRET', 'PROBE_COLLECTION_HANDLE', 'PROBE_PRODUCT_ID', 'PROBE_VARIANT_ID'];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new ProbeConfigurationError(`Missing GitHub environment settings: ${missing.join(', ')}.`);
  if (!/^[a-z0-9]{20}$/.test(env.PROBE_SUPABASE_REF)) throw new ProbeConfigurationError('PROBE_SUPABASE_REF must be the 20-character project reference, without a URL.');
  if (env.PROBE_SUPABASE_SCHEMA && env.PROBE_SUPABASE_SCHEMA !== PROBE_SCHEMA) {
    throw new ProbeConfigurationError('Only the monitoring_test schema is allowed.');
  }
  const shop = env.PROBE_SHOPIFY_SHOP.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new ProbeConfigurationError('PROBE_SHOPIFY_SHOP must be a myshopify.com hostname, without https:// or a path.');
  for (const key of ['PROBE_PRODUCT_ID', 'PROBE_VARIANT_ID']) {
    if (!/^[1-9]\d*$/.test(env[key])) throw new ProbeConfigurationError(`Use a numeric ID for ${key}.`);
  }
  return { schema: PROBE_SCHEMA, ref: env.PROBE_SUPABASE_REF, shop, url: `https://${env.PROBE_SUPABASE_REF}.supabase.co` };
}

async function invoke(handler, body) {
  let status = 200, result;
  const res = { setHeader() {}, status(code) { status = code; return this; }, json(value) { result = value; return this; } };
  await handler({ method: 'POST', headers: { origin: 'https://monitoring.invalid', 'content-type': 'application/json' }, body }, res);
  if (status !== 200 || result?.success !== true) throw new ProbeCheckError('Synthetic submission failed.');
  return result;
}

export async function runRequestCaptureProbe({ env, db: client, graphql, onStage = () => {} }) {
  const config = probeConfig(env);
  // Pin every table read/write AND RPC to the test schema, regardless of client defaults.
  // If the schema is not exposed or its marker is absent, stop; never retry in public.
  onStage('Supabase test schema');
  const db = client.schema(PROBE_SCHEMA);
  const marker = await db.from('monitoring_test_environment')
    .select('schema_name,version').eq('schema_name', PROBE_SCHEMA).single();
  if (marker.error?.code === 'PGRST106') throw new ProbeCheckError('Add monitoring_test to Supabase Data API exposed schemas.');
  if (marker.status === 401 || marker.status === 403) throw new ProbeCheckError('Supabase rejected the probe server key or schema permissions.');
  if (['PGRST205', '42P01'].includes(marker.error?.code)) throw new ProbeCheckError('The monitoring_test marker table was not found. Run the monitoring SQL in the configured project.');
  if (marker.error || marker.data?.schema_name !== PROBE_SCHEMA || marker.data?.version !== 1) {
    throw new ProbeCheckError('Test schema marker is missing or incompatible.');
  }
  onStage('Shopify authentication and development store identity');
  const identity = await graphql('query MonitoringDevelopmentShop { shop { myshopifyDomain plan { partnerDevelopment } } }');
  if (identity.shop?.myshopifyDomain !== config.shop || identity.shop?.plan?.partnerDevelopment !== true) {
    throw new ProbeCheckError('A verified Shopify development store is required.');
  }
  const runId = randomUUID(), email = `monitoring+${runId}@example.com`;
  const probeEnv = { POPUP_ALLOWED_ORIGINS: 'https://monitoring.invalid',
    BECOMING_ACCESS_COLLECTION_HANDLE: env.PROBE_COLLECTION_HANDLE,
    BECOMING_ACCESS_CAMPAIGN: 'monitoring-synthetic', BECOMING_ACCESS_CUSTOMER_TAGS: 'monitoring-test',
    RAFFLE_EVENT_ID: 'monitoring-synthetic', RAFFLE_ENTRIES_OPEN: 'true' };
  onStage('Becoming Access submission');
  const access = await invoke(createBecomingAccessHandler({ db, graphql, env: probeEnv }), {
    name: 'Monitoring Synthetic Check', email, phone: '', marketingConsent: false, smsConsent: false,
    interests: [{ productId: env.PROBE_PRODUCT_ID, variantId: env.PROBE_VARIANT_ID }],
  });
  if (access.consentSynced !== true) throw new ProbeCheckError('Synthetic Shopify sync failed.');
  onStage('Becoming Access saved records');
  const contact = await db.from('becoming_access_contacts').select('id,shopify_customer_id').eq('email', email).single();
  if (contact.error || !contact.data?.shopify_customer_id) throw new ProbeCheckError('Synthetic contact was not persisted.');
  const submission = await db.from('becoming_access_submissions')
    .select('id,shopify_sync_status,becoming_access_interests(product_id,variant_id)')
    .eq('contact_id', contact.data.id).eq('campaign', 'monitoring-synthetic').single();
  const interests = submission.data?.becoming_access_interests;
  if (submission.error || submission.data?.shopify_sync_status !== 'synced' || interests?.length !== 1 ||
      interests[0].product_id !== `gid://shopify/Product/${env.PROBE_PRODUCT_ID}` ||
      interests[0].variant_id !== `gid://shopify/ProductVariant/${env.PROBE_VARIANT_ID}`) {
    throw new ProbeCheckError('Synthetic interests were not persisted.');
  }
  onStage('Raffle submission');
  const raffle = await invoke(createRaffleHandler({ db, env: probeEnv }), {
    name: 'Monitoring Synthetic Check', eventId: probeEnv.RAFFLE_EVENT_ID, requestId: runId,
  });
  onStage('Raffle saved record');
  const entry = await db.from('raffle_entries').select('entry_number')
    .eq('event_id', probeEnv.RAFFLE_EVENT_ID).eq('request_id', runId).single();
  if (entry.error || String(entry.data?.entry_number) !== String(raffle.entry?.number)) throw new ProbeCheckError('Synthetic raffle entry was not persisted.');
  return { status: 'ok', checks: { becoming_access: 'ok', shopify_sync: 'ok', raffle: 'ok' } };
}
