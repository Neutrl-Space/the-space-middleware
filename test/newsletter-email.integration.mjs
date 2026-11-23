// Optional generic Liquid renderer check; actual Shopify personalization still needs an Admin-side test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

test('Shopify welcome email renders the assigned code only while it is unambiguous and eligible', async () => {
  const { Liquid } = createRequire(import.meta.url)(process.env.NEWSLETTER_TEST_LIQUID || 'liquidjs');
  const engine = new Liquid({ strictFilters: true, strictVariables: true });
  const template = await fs.readFile(new URL('../docs/newsletter-welcome-email.liquid', import.meta.url), 'utf8');
  const expiry = new Date(Date.now() + 7 * 86400000).toISOString();
  const tags = ['ns-welcome-ready', 'ns-welcome-code:NS15TEST', `ns-welcome-expires:${expiry}`];
  const render = (changes = {}) => engine.parseAndRender(template, {
    shop: { url: 'https://example.com' },
    customer: { accepts_marketing: true, orders_count: 0, first_name: '<Ada>', tags, ...changes },
  });
  const valid = await render();
  assert.match(valid, /NS15TEST/); assert.match(valid, /\/discount\/NS15TEST/);
  assert.match(valid, /&lt;Ada&gt;/); assert.equal(valid.includes('<Ada>'), false);
  for (const changes of [
    { accepts_marketing: false }, { orders_count: 1 }, { tags: [] },
    { tags: [...tags, 'ns-welcome-code:NS15SECOND'] },
    { tags: ['ns-welcome-ready', 'ns-welcome-code:NS15TEST', 'ns-welcome-expires:2000-01-01T00:00:00Z'] },
    { tags: ['ns-welcome-ready', 'ns-welcome-code:NS15TEST', 'ns-welcome-expires:invalid'] },
  ]) {
    const html = await render(changes);
    assert.equal(html.includes('NS15TEST'), false); assert.equal(html.includes('/discount/'), false);
  }
});

test('reminder email requires the separate reminder tag and hides expired or purchased offers', async () => {
  const { Liquid } = createRequire(import.meta.url)(process.env.NEWSLETTER_TEST_LIQUID || 'liquidjs');
  const engine = new Liquid({ strictFilters: true, strictVariables: true });
  const template = await fs.readFile(new URL('../docs/newsletter-reminder-email.liquid', import.meta.url), 'utf8');
  const tags = ['ns-welcome-ready', 'ns-welcome-reminder-ready', 'ns-welcome-code:HELLO-23456789', `ns-welcome-expires:${new Date(Date.now() + 12 * 3600000).toISOString()}`];
  const render = (changes = {}) => engine.parseAndRender(template, { shop: { url: 'https://example.com' },
    customer: { accepts_marketing: true, orders_count: 0, first_name: 'Ada', tags, ...changes } });
  const valid = await render(); assert.match(valid, /HELLO-23456789/); assert.match(valid, /still yours to use/);
  for (const changes of [
    { accepts_marketing: false }, { orders_count: 1 }, { tags: tags.filter((tag) => tag !== 'ns-welcome-reminder-ready') },
    { tags: tags.map((tag) => tag.startsWith('ns-welcome-expires:') ? 'ns-welcome-expires:2000-01-01T00:00:00Z' : tag) },
  ]) assert.equal((await render(changes)).includes('HELLO-23456789'), false);
});
