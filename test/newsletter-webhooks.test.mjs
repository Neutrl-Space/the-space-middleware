import test from 'node:test';
import assert from 'node:assert/strict';
import { newsletterWebhookUrl, configureNewsletterWebhooks, probeNewsletterWebhook, NEWSLETTER_WEBHOOK_TOPICS } from '../lib/newsletter-webhooks.js';
import { verifyNewsletterWebhook } from '../lib/newsletter.js';

const env = { SHOPIFY_SHOP: 'test-shop', SHOPIFY_CLIENT_SECRET: 'test-only', NEWSLETTER_ENABLED: 'false',
  NEWSLETTER_WEBHOOKS_ENABLED: 'true', MIDDLEWARE_URL: 'https://test-only.example', SHOPIFY_API_VERSION: '2026-01' };
const url = `${env.MIDDLEWARE_URL}/api/newsletter/webhook`;
const subscription = (topic, extra = {}) => ({ id: topic, topic, uri: url, format: 'JSON', filter: null,
  includeFields: [], apiVersion: { handle: '2026-01' }, ...extra });

test('webhook registration accepts a public HTTPS base URL and rejects credentials or query fragments', () => {
  assert.equal(newsletterWebhookUrl(env), url);
  for (const value of ['', 'http://example.com', 'https://localhost', 'https://user:secret@example.com', 'https://example.com?secret=x', 'https://example.com#x', 'https://example.com/api']) {
    assert.throws(() => newsletterWebhookUrl({ MIDDLEWARE_URL: value }));
  }
});

test('read-only registration check lists missing subscriptions without probing or creating them', async () => {
  let calls = 0;
  const result = await configureNewsletterWebhooks({ env, graphql: async (query, variables) => {
    calls++; assert.match(query, /query NewsletterWebhookSubscriptions/); assert.deepEqual(variables.topics, NEWSLETTER_WEBHOOK_TOPICS);
    return { webhookSubscriptions: { nodes: [], pageInfo: { hasNextPage: false } } };
  }, probe: async () => { throw new Error('Must not probe in read-only mode'); } });
  assert.equal(calls, 1); assert.equal(result.url, url);
  assert.deepEqual(result.subscriptions.map((item) => item.status), ['would-create', 'would-create', 'would-create']);
});

test('registration reuses existing subscriptions and creates only missing ones after endpoint verification', async () => {
  const existing = [subscription('CUSTOMERS_CREATE')];
  let probed = false, creates = 0;
  const graphql = async (query, variables) => {
    if (query.includes('query NewsletterWebhookSubscriptions')) return { webhookSubscriptions: { nodes: existing, pageInfo: { hasNextPage: false } } };
    assert.equal(probed, true); creates++;
    assert.deepEqual(variables.input, { uri: url, format: 'JSON' });
    const created = subscription(variables.topic); existing.push(created);
    return { webhookSubscriptionCreate: { webhookSubscription: created, userErrors: [] } };
  };
  const probe = async (args) => { assert.equal(args.url, url); probed = true; };
  const first = await configureNewsletterWebhooks({ env, graphql, probe, apply: true });
  assert.deepEqual(first.subscriptions.map((item) => item.status), ['existing', 'created', 'created']);
  assert.equal(creates, 2);
  const second = await configureNewsletterWebhooks({ env, graphql, probe, apply: true });
  assert.ok(second.subscriptions.every((item) => item.status === 'existing')); assert.equal(creates, 2);
});

test('duplicate, filtered or incompatible subscriptions stop setup instead of creating more', async () => {
  for (const nodes of [
    [subscription('CUSTOMERS_CREATE'), subscription('CUSTOMERS_CREATE')],
    [subscription('CUSTOMERS_CREATE', { filter: 'id:123' })],
    [subscription('CUSTOMERS_CREATE', { includeFields: ['id'] })],
    [subscription('CUSTOMERS_CREATE', { apiVersion: { handle: '2025-01' } })],
  ]) {
    let calls = 0;
    await assert.rejects(configureNewsletterWebhooks({ env, apply: true, graphql: async () => {
      calls++; return { webhookSubscriptions: { nodes, pageInfo: { hasNextPage: false } } };
    }, probe: async () => { throw new Error('Should stop before probing'); } }));
    assert.equal(calls, 1);
  }
});

test('registration follows pagination before deciding whether a topic already exists', async () => {
  let reads = 0;
  const result = await configureNewsletterWebhooks({ env, graphql: async (_, variables) => {
    reads++;
    if (!variables.after) return { webhookSubscriptions: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page-2' } } };
    assert.equal(variables.after, 'page-2');
    return { webhookSubscriptions: { nodes: NEWSLETTER_WEBHOOK_TOPICS.map((topic) => subscription(topic)), pageInfo: { hasNextPage: false } } };
  } });
  assert.equal(reads, 2); assert.ok(result.subscriptions.every((item) => item.status === 'existing'));
});

test('endpoint probe sends a valid signed unsubscription that never creates a queued subscriber', async () => {
  let called = false;
  await probeNewsletterWebhook({ url, env, fetcher: async (target, request) => {
    called = true; assert.equal(target, url); assert.equal(request.redirect, 'error');
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const verified = verifyNewsletterWebhook(Buffer.from(request.body), headers, env);
    assert.equal(verified.event, null);
    return { ok: true, json: async () => ({ accepted: true }) };
  } });
  assert.equal(called, true);
  await assert.rejects(probeNewsletterWebhook({ url, env, fetcher: async () => ({ ok: false, status: 503 }) }));
});
