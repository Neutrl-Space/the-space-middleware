// Optional, isolated PostgreSQL integration check. No Supabase connection or credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { newsletterConfig } from '../lib/newsletter.js';

test('newsletter migration, permissions, deduplication, leases and event races in PostgreSQL', async (t) => {
  const { PGlite } = createRequire(import.meta.url)(process.env.NEWSLETTER_TEST_PGLITE || '@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(await fs.readFile(new URL('../supabase/newsletter.sql', import.meta.url), 'utf8'));
    const config = newsletterConfig({ SHOPIFY_SHOP: 'test-shop' });
    const shop = config.shop;
    const event = (eventId = 'event-1', customerId = 'gid://shopify/Customer/123') => ({ eventId, customerId, shop,
      kind: 'subscribe', topic: 'customers_email_marketing_consent/update', consentAt: new Date().toISOString(), optInLevel: 'confirmed_opt_in' });
    const enqueue = (data, rules = config.rules) => db.query('select enqueue_newsletter_event($1::jsonb,$2,$3::jsonb)', [JSON.stringify(data), config.campaign, JSON.stringify(rules)]);
    const claim = async () => (await db.query('select claim_newsletter_job($1,$2) as job', [shop, config.campaign])).rows[0].job;
    const finish = (job, changes) => db.query('select finish_newsletter_job($1::uuid,$2::uuid,$3::jsonb)', [job.id, job.lease_token, JSON.stringify(changes)]);
    const reset = () => db.exec('truncate newsletter_events, newsletter_assignments;');
    const reserve = (job) => db.query(`update newsletter_assignments set code='NS15FIXED', starts_at=now(), ends_at=now()+interval '7 days' where id=$1 returning *`, [job.id]);

    await t.test('anonymous access is denied and an incomplete baseline fails without acknowledging the event', async () => {
      const permissions = await db.query(`select has_table_privilege('anon','newsletter_assignments','SELECT') as readable,
        has_function_privilege('anon','claim_newsletter_job(text,text)','EXECUTE') as executable`);
      assert.equal(permissions.rows[0].readable, false); assert.equal(permissions.rows[0].executable, false);
      await assert.rejects(enqueue(event()));
      assert.equal((await db.query('select count(*)::int as count from newsletter_events')).rows[0].count, 0);
      await db.query('insert into newsletter_campaigns(shop,campaign,baseline_completed_at) values($1,$2,now())', [shop, config.campaign]);
    });
    await t.test('duplicate receipts and overlapping customer deliveries create one assignment', async () => {
      await enqueue(event()); await enqueue(event()); await enqueue(event('event-2'));
      assert.equal((await db.query('select count(*)::int as count from newsletter_events')).rows[0].count, 2);
      assert.equal((await db.query('select count(*)::int as count from newsletter_assignments')).rows[0].count, 1);
      const job = await claim(); assert.ok(job.lease_token); assert.equal(await claim(), null);
      await db.query("update newsletter_assignments set lease_until=now()-interval '1 second' where id=$1", [job.id]);
      const recovered = await claim(); assert.notEqual(recovered.lease_token, job.lease_token);
      await assert.rejects(finish(job, { status: 'published' }));
      await finish(recovered, { status: 'published' }); assert.equal(await claim(), null);
    });
    await t.test('repeated signup never changes the reserved code, expiry or policy snapshot', async () => {
      await reset(); await enqueue(event()); const job = await claim();
      const original = (await reserve(job)).rows[0];
      await enqueue(event('event-2'), { ...config.rules, validityDays: 90 });
      const row = (await db.query('select * from newsletter_assignments')).rows[0];
      assert.equal(row.code, 'NS15FIXED'); assert.equal(String(row.ends_at), String(original.ends_at));
      assert.equal(row.rules.validityDays, 7); assert.ok(row.rules.launchedAt);
    });
    await t.test('an order arriving during issuance cannot be overwritten by email-handoff completion', async () => {
      await reset(); await enqueue(event()); const job = await claim(); await reserve(job);
      await enqueue({ ...event('order-event'), kind: 'order', topic: 'orders/create', orderId: '456', codes: [] });
      await finish(job, { status: 'published', discount_id: 'discount-1' });
      const revokeJob = await claim();
      assert.equal(revokeJob.revocation_requested, true); assert.equal(revokeJob.code, 'NS15FIXED');
      await finish(revokeJob, { status: 'revoked' }); assert.equal(await claim(), null);
    });
    await t.test('observed redemption remains final even when an older worker fails afterward', async () => {
      await reset(); await enqueue(event()); const job = await claim(); await reserve(job);
      await enqueue({ ...event('order-event'), kind: 'order', topic: 'orders/create', orderId: '456', codes: ['NS15FIXED'] });
      await finish(job, { status: 'pending', reason: 'processing_failed' });
      const row = (await db.query('select * from newsletter_assignments')).rows[0];
      assert.equal(row.status, 'redeemed'); assert.equal(row.redeemed_order_id, '456'); assert.equal(await claim(), null);
    });
    await t.test('baseline exclusions do not revive, while an unconfirmed creation candidate can later opt in', async () => {
      await reset(); await enqueue(event()); const job = await claim();
      await finish(job, { status: 'ineligible', reason: 'existing_subscriber' });
      await enqueue(event('event-2')); assert.equal(await claim(), null);
      await db.query("update newsletter_assignments set reason='not_subscribed' where id=$1", [job.id]);
      await enqueue(event('event-3')); assert.equal((await claim()).id, job.id);
    });
    await t.test('failed work backs off and overlapping claims lease different customers', async () => {
      await reset(); await enqueue(event()); await enqueue(event('event-2', 'gid://shopify/Customer/999'));
      const [first, second] = await Promise.all([claim(), claim()]);
      assert.notEqual(first.id, second.id); assert.equal(await claim(), null);
      await finish(first, { status: 'pending', reason: 'processing_failed' });
      const row = (await db.query('select next_attempt_at > now() as waiting from newsletter_assignments where id=$1', [first.id])).rows[0];
      assert.equal(row.waiting, true); assert.equal(await claim(), null);
    });
  } finally { await db.close(); }
});
