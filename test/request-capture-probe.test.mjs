import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeConfig, runRequestCaptureProbe } from '../lib/request-capture-probe.js';
const env = { PROBE_SUPABASE_REF: 'a'.repeat(20),
  PROBE_SUPABASE_SERVICE_KEY: 'test-key', PROBE_SHOPIFY_SHOP: 'isolated-test.myshopify.com',
  PROBE_SHOPIFY_CLIENT_ID: 'test-id', PROBE_SHOPIFY_CLIENT_SECRET: 'test-secret', PROBE_COLLECTION_HANDLE: 'becoming', PROBE_PRODUCT_ID: '1', PROBE_VARIANT_ID: '2' };

test('shared projects are allowed but alternate schemas and implicit app credentials are rejected', () => {
  assert.equal(probeConfig(env).schema, 'monitoring_test');
  assert.throws(() => probeConfig({ ...env, PROBE_SUPABASE_SCHEMA: 'public' }));
  assert.throws(() => probeConfig({ ...env, PROBE_SUPABASE_SCHEMA: 'other' }));
  assert.throws(() => probeConfig({ SUPABASE_URL: 'https://production.supabase.co', SHOPIFY_SHOP: env.PROBE_SHOPIFY_SHOP }));
  assert.throws(() => probeConfig({ ...env, PROBE_SHOPIFY_SHOP: 'evil.example/path' }));
});

function fixture({ marker = true, dev = true, missingInterest = false, missingRaffle = false } = {}) {
  const writes = [], mutations = [];
  let saved, number;
  const interest = { product_id: 'gid://shopify/Product/1', variant_id: 'gid://shopify/ProductVariant/2', product_title: 'Test', product_handle: 'test' };
  const scoped = {
    async rpc(name, args) {
      writes.push(name);
      if (name === 'save_becoming_access_request') { saved = args.request_data; return { data: { contact_id: 'contact', submission_id: 'submission' } }; }
      number = args.p_number;
      return { data: { name: args.p_name, number } };
    },
    from(table) {
      const chain = {
        select() { return this; }, eq() { return this; },
        update(value) { writes.push(value); return this; },
        then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
        async single() {
          if (table === 'monitoring_test_environment') return marker ? { data: { schema_name: 'monitoring_test', version: 1 } } : { error: {} };
          if (table === 'becoming_access_contacts') return { data: { id: 'contact', shopify_customer_id: 'customer' } };
          if (table === 'raffle_entries') return missingRaffle ? { error: {} } : { data: { entry_number: number } };
          return { data: { id: 'submission', campaign: 'monitoring-synthetic', created_at: new Date().toISOString(),
            shopify_sync_status: 'synced', becoming_access_interests: missingInterest ? [] : [interest] } };
        },
      };
      return chain;
    },
  };
  const db = {
    schema(name) { assert.equal(name, 'monitoring_test'); return scoped; },
    from() { throw new Error('Unscoped database access'); },
    rpc() { throw new Error('Unscoped RPC'); },
  };
  const graphql = async (query, variables) => {
    if (query.includes('MonitoringDevelopmentShop')) return { shop: { myshopifyDomain: env.PROBE_SHOPIFY_SHOP, plan: { partnerDevelopment: dev } } };
    if (query.includes('mutation')) mutations.push({ query, variables });
    if (query.includes('AccessCollection')) return { collectionByIdentifier: { id: 'collection' } };
    if (query.includes('AccessSelections')) return { nodes: [
      { id: interest.product_id, title: 'Test', handle: 'test', inCollection: true },
      { id: interest.variant_id, title: 'M', product: { id: interest.product_id }, selectedOptions: [{ name: 'Size', value: 'M' }] },
    ] };
    if (query.includes('query AccessCustomer')) return { customers: { nodes: [] } };
    if (query.includes('CreateAccessCustomer')) return { customerCreate: { customer: { id: 'customer' }, userErrors: [] } };
    if (query.includes('TagAccessCustomer')) return { tagsAdd: { userErrors: [] } };
    if (query.includes('AccessPreferenceSnapshot')) return { customer: { snapshot: null, summary: null } };
    if (query.includes('SaveAccessPreferences')) return { metafieldsSet: { userErrors: [] } };
    throw new Error('Unexpected query');
  };
  return { db, graphql, writes, mutations, get saved() { return saved; } };
}

test('missing database marker and a non-development shop prevent all writes', async () => {
  for (const options of [{ marker: false }, { dev: false }]) {
    const f = fixture(options);
    await assert.rejects(runRequestCaptureProbe({ env, ...f }));
    assert.equal(f.writes.length, 0);
    assert.equal(f.mutations.length, 0);
  }
});

test('real handlers save synthetic entries without granting marketing consent or production tags', async () => {
  const f = fixture();
  const result = await runRequestCaptureProbe({ env, ...f });
  assert.equal(result.status, 'ok');
  assert.equal(f.saved.marketingConsent, false);
  assert.equal(f.saved.smsConsent, false);
  assert.equal(f.saved.campaign, 'monitoring-synthetic');
  assert.match(f.saved.email, /@example.com$/);
  assert.deepEqual(f.mutations.find(m => m.query.includes('TagAccessCustomer')).variables.tags, ['monitoring-test']);
  assert(!f.mutations.some(m => m.query.includes('MarketingConsent')));
  assert(f.writes.includes('register_raffle_entry'));
});

test('successful handler responses do not conceal missing persisted interests or raffle entries', async () => {
  for (const options of [{ missingInterest: true }, { missingRaffle: true }]) {
    await assert.rejects(runRequestCaptureProbe({ env, ...fixture(options) }));
  }
});

test('Supabase sends the test schema profile for every read, insert RPC, and sync update', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const requests = [];
  let number;
  const db = createClient(`https://${env.PROBE_SUPABASE_REF}.supabase.co`, 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => {
      const path = new URL(url).pathname, method = options.method || 'GET';
      const headers = new Headers(options.headers);
      requests.push({ path, method, headers });
      assert.equal(headers.get(method === 'GET' || method === 'HEAD' ? 'Accept-Profile' : 'Content-Profile'), 'monitoring_test');
      let body;
      if (path.endsWith('/monitoring_test_environment')) body = { schema_name: 'monitoring_test', version: 1 };
      else if (path.endsWith('/rpc/save_becoming_access_request')) body = { submission_id: 'submission', contact_id: 'contact' };
      else if (path.endsWith('/rpc/register_raffle_entry')) {
        const args = JSON.parse(options.body); number = args.p_number;
        body = { name: args.p_name, number };
      } else if (method === 'PATCH') body = [];
      else if (path.endsWith('/becoming_access_contacts')) body = { id: 'contact', shopify_customer_id: 'customer' };
      else if (path.endsWith('/becoming_access_submissions')) body = { id: 'submission', created_at: new Date().toISOString(), campaign: 'monitoring-synthetic', shopify_sync_status: 'synced',
        becoming_access_interests: [{ product_id: 'gid://shopify/Product/1', variant_id: 'gid://shopify/ProductVariant/2', product_handle: 'test', product_title: 'Test' }] };
      else if (path.endsWith('/raffle_entries')) body = { entry_number: number };
      else throw new Error('Unexpected request');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  assert.equal((await runRequestCaptureProbe({ env, db, graphql: fixture().graphql })).status, 'ok');
  assert(requests.some(r => r.method === 'PATCH'));
  assert.equal(requests.filter(r => r.path.includes('/rpc/')).length, 2);
});

test('unexposed schema stops after one marker read without calling Shopify or public', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  let calls = 0;
  const db = createClient(`https://${env.PROBE_SUPABASE_REF}.supabase.co`, 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ code: 'PGRST106', message: 'Schema is not exposed' }), { status: 406, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  await assert.rejects(runRequestCaptureProbe({ env, db, graphql: () => { throw new Error('Should not call Shopify'); } }), /exposed schemas/);
  assert.equal(calls, 1);
});

test('CLI lists missing setting names without printing existing secret values', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/check-request-capture.mjs'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
      PROBE_SUPABASE_SERVICE_KEY: 'private-database-value',
      PROBE_SHOPIFY_CLIENT_ID: 'private-client-value',
      PROBE_SHOPIFY_CLIENT_SECRET: 'private-secret-value',
    },
  });
  assert.equal(result.status, 1);
  for (const name of ['PROBE_SUPABASE_REF', 'PROBE_SHOPIFY_SHOP', 'PROBE_COLLECTION_HANDLE', 'PROBE_PRODUCT_ID', 'PROBE_VARIANT_ID']) {
    assert(result.stderr.includes(name));
  }
  assert(!result.stderr.includes('private-'));
});

test('schema diagnostics show an actionable fixed message and stop before Shopify', async () => {
  for (const [marker, expected] of [
    [{ status: 401, error: { message: 'private upstream content' } }, /server key/],
    [{ status: 404, error: { code: 'PGRST205', message: 'private upstream content' } }, /marker table was not found/],
  ]) {
    const stages = [];
    const db = { schema: () => ({ from: () => ({ select() { return this; }, eq() { return this; }, single: async () => marker }) }) };
    await assert.rejects(runRequestCaptureProbe({ env, db,
      onStage: s => stages.push(s), graphql: () => assert.fail('No Shopify request allowed') }), e => expected.test(e.message) && !e.message.includes('private'));
    assert.deepEqual(stages, ['Supabase test schema']);
  }
});
