import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbeShopifyGraphql } from '../lib/probe-shopify.js';
const config = { shop: 'neutrl-monitoring-test.myshopify.com', clientId: 'test-id', clientSecret: 'test-secret' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('test app exchanges credentials, caches its token, and refreshes before expiration', async () => {
  let time = 0, tokens = 0;
  const graphql = createProbeShopifyGraphql({ ...config, now: () => time, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert(options.signal);
    if (url.endsWith('/access_token')) {
      tokens++;
      assert.equal(options.body.get('grant_type'), 'client_credentials');
      assert.equal(options.body.get('client_secret'), config.clientSecret);
      return reply({ access_token: `token-${tokens}`, expires_in: 86399 });
    }
    assert.equal(options.headers['X-Shopify-Access-Token'], `token-${tokens}`);
    assert(!options.body.includes(config.clientSecret));
    return reply({ data: { shop: { id: 'shop' } } });
  } });
  await graphql('query Test { shop { id } }');
  await graphql('query Test { shop { id } }');
  assert.equal(tokens, 1);
  time = 86400000;
  await graphql('query Test { shop { id } }');
  assert.equal(tokens, 2);
});

test('failed or incomplete token responses prevent GraphQL requests and redact provider messages', async () => {
  for (const response of [() => reply({ error: 'secret upstream detail' }, 403), () => reply({ access_token: 'token' })]) {
    let calls = 0;
    const graphql = createProbeShopifyGraphql({ ...config, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(graphql('query Test { shop { id } }'), e => !e.message.includes('secret upstream detail'));
    assert.equal(calls, 1);
  }
});
