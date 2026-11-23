import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

test('instant-offer migration enforces targeted leases, rate limits and one reminder per 24-hour offer', async (t) => {
  const { PGlite } = createRequire(import.meta.url)(process.env.NEWSLETTER_TEST_PGLITE || '@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    for (const name of ['newsletter.sql', 'newsletter-instant-offers.sql']) {
      await db.exec(await fs.readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8'));
    }
    await db.exec("insert into newsletter_campaigns values ('test.myshopify.com','welcome-v1',now());");
    const add = async (id, { days = 1, age = 12.1, status = 'published', revoke = false } = {}) => {
      return (await db.query(`insert into newsletter_assignments(shop,campaign,customer_id,rules,code,starts_at,ends_at,status,revocation_requested)
        values('test.myshopify.com','welcome-v1',$1,$2::jsonb,$3,now()-make_interval(secs=>$4),now()-make_interval(secs=>$4)+make_interval(days=>$5),$6,$7) returning *`,
      [id, JSON.stringify({ validityDays: days }), `CODE-${id}`, age * 3600, days, status, revoke])).rows[0];
    };
    const claim = async () => (await db.query("select claim_newsletter_reminder('test.myshopify.com','welcome-v1') as job")).rows[0].job;
    const finish = (j, state) => db.query('select finish_newsletter_reminder($1,$2,$3,null)', [j.id, j.reminder_lease_token, state]);
    await t.test('service-only tables and functions', async () => {
      const row = (await db.query(`select has_table_privilege('anon','newsletter_status_limits','SELECT') as readable,
        has_function_privilege('anon','claim_newsletter_customer_job(text,text,text)','EXECUTE') as claimable,
        has_function_privilege('authenticated','claim_newsletter_reminder(text,text)','EXECUTE') as reminder`)).rows[0];
      assert.deepEqual(row, { readable: false, claimable: false, reminder: false });
    });
    await t.test('limits apply to both IP and token and old buckets reset', async () => {
      const allow = async (client, token) => (await db.query('select allow_newsletter_status($1,$2) as allowed', [client, token])).rows[0].allowed;
      for (let i = 0; i < 30; i++) assert.equal(await allow('client', 'token'), true);
      assert.equal(await allow('client', 'new-token'), false);
      assert.equal(await allow('new-client', 'token'), false);
      await db.exec("update newsletter_status_limits set window_start=now()-interval '2 minutes';");
      assert.equal(await allow('client', 'token'), true);
    });
    await t.test('targeted issuance cannot claim another customer or overlap the regular worker', async () => {
      await add('first', { status: 'pending', age: 0 }); await add('second', { status: 'pending', age: 0 });
      const targeted = (await db.query("select claim_newsletter_customer_job('test.myshopify.com','welcome-v1','second') as job")).rows[0].job;
      assert.equal(targeted.customer_id, 'second');
      assert.equal((await db.query("select claim_newsletter_customer_job('test.myshopify.com','welcome-v1','second') as job")).rows[0].job, null);
      const other = (await db.query("select claim_newsletter_job('test.myshopify.com','welcome-v1') as job")).rows[0].job;
      assert.equal(other.customer_id, 'first');
      await db.exec('truncate newsletter_assignments;');
    });
    await t.test('only 24-hour offers at least 12 hours old are due', async () => {
      await add('early', { age: 11.99 }); await add('legacy', { days: 7 });
      await add('revoking', { revoke: true }); await add('redeemed', { status: 'redeemed' });
      const due = await add('due');
      const first = await claim(); assert.equal(first.id, due.id); assert.equal(await claim(), null);
      await db.query("update newsletter_assignments set reminder_lease_until=now()-interval '1 second' where id=$1", [due.id]);
      const recovered = await claim(); assert.notEqual(recovered.reminder_lease_token, first.reminder_lease_token);
      await assert.rejects(finish(first, 'published'));
      await finish(recovered, 'published'); assert.equal(await claim(), null);
      const saved = (await db.query('select reminder_status,reminder_published_at from newsletter_assignments where id=$1', [due.id])).rows[0];
      assert.equal(saved.reminder_status, 'published'); assert.ok(saved.reminder_published_at);
    });
    await t.test('expired offers can be claimed once for explicit skip, and retries back off', async () => {
      await db.exec('truncate newsletter_assignments;');
      await add('expired', { age: 25 }); const expired = await claim(); await finish(expired, 'skipped');
      await add('retry'); const retry = await claim(); await finish(retry, 'pending'); assert.equal(await claim(), null);
      const row = (await db.query('select reminder_status,reminder_next_attempt_at>now() as waiting from newsletter_assignments where id=$1', [retry.id])).rows[0];
      assert.deepEqual(row, { reminder_status: 'pending', waiting: true });
    });
  } finally { await db.close(); }
});
