// Isolated PostgreSQL test. No Supabase credentials or hosted connections.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

test('monitoring schema migration isolates synthetic writes and denies browser roles', async (t) => {
  const { PGlite } = createRequire(import.meta.url)(process.env.MONITORING_TEST_PGLITE || '@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.becoming_access_contacts(sentinel text);
      create table public.becoming_access_submissions(sentinel text);
      create table public.becoming_access_interests(sentinel text);
      create table public.raffle_entries(sentinel text);
      create table public.monitoring_test_environment(sentinel text);
      insert into public.becoming_access_contacts values ('live customer');
      insert into public.raffle_entries values ('live entry');
      create function public.save_becoming_access_request(jsonb) returns jsonb language plpgsql as
        $$ begin raise exception 'Production RPC must not run'; end; $$;
      create function public.register_raffle_entry(text,uuid,text,integer) returns jsonb language plpgsql as
        $$ begin raise exception 'Production RPC must not run'; end; $$;`);
    const migration = await fs.readFile(new URL('../supabase/monitoring-test-environment.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const payload = {
      name: 'Monitoring Synthetic Check', email: 'monitoring+00000000-0000-4000-8000-000000000001@example.com',
      phone: '', marketingConsent: false, campaign: 'monitoring-synthetic',
      attribution: {}, syncPayload: { marketingConsent: false, smsConsent: false },
      interests: [{ productId: 'gid://shopify/Product/1', productHandle: 'test', productTitle: 'Test', variantId: 'gid://shopify/ProductVariant/2' }],
    };
    const save = async (value) => (await db.query('select monitoring_test.save_becoming_access_request($1::jsonb) as result', [JSON.stringify(value)])).rows[0].result;
    await t.test('service role saves only to test tables and foreign keys reference test tables', async () => {
      await db.exec('set role service_role;');
      const saved = await save(payload);
      assert.ok(saved.contact_id); assert.ok(saved.submission_id);
      const rows = await db.query(`select c.email, s.campaign, i.product_id
        from monitoring_test.becoming_access_contacts c
        join monitoring_test.becoming_access_submissions s on s.contact_id=c.id
        join monitoring_test.becoming_access_interests i on i.submission_id=s.id`);
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].email, payload.email);
      const args = ['monitoring-synthetic', '00000000-0000-4000-8000-000000000002', 'Monitoring Synthetic Check', 123456];
      const raffle = () => db.query('select monitoring_test.register_raffle_entry($1,$2::uuid,$3,$4) as result', args);
      assert.equal((await raffle()).rows[0].result.number, 123456);
      assert.equal((await raffle()).rows[0].result.number, 123456);
      assert.equal((await db.query('select count(*)::int as count from monitoring_test.raffle_entries')).rows[0].count, 1);
      await db.exec('reset role;');
    });
    await t.test('real addresses, marketing consent, and production campaigns/events are rejected atomically', async () => {
      await db.exec('set role service_role;');
      for (const changes of [{ email: 'real@example.org' }, { marketingConsent: true }, { campaign: 'live' }, { interests: [] }]) {
        await assert.rejects(save({ ...payload, ...changes }));
      }
      await assert.rejects(db.query("select monitoring_test.register_raffle_entry('live',$1::uuid,'Test',123457)", ['00000000-0000-4000-8000-000000000003']));
      assert.equal((await db.query('select count(*)::int as count from monitoring_test.becoming_access_submissions')).rows[0].count, 1);
      await db.exec('reset role;');
    });
    await t.test('anonymous and authenticated users cannot use the schema or execute its RPCs', async () => {
      for (const role of ['anon', 'authenticated']) {
        const perms = (await db.query(`select has_schema_privilege($1,'monitoring_test','USAGE') as usable,
          has_function_privilege($1,'monitoring_test.save_becoming_access_request(jsonb)','EXECUTE') as callable,
          has_table_privilege($1,'monitoring_test.becoming_access_contacts','SELECT') as readable`, [role])).rows[0];
        assert.deepEqual(perms, { usable: false, callable: false, readable: false });
      }
    });
    await t.test('public rows, public table definitions, and public RPCs remain untouched', async () => {
      assert.deepEqual((await db.query('select * from public.becoming_access_contacts')).rows, [{ sentinel: 'live customer' }]);
      assert.deepEqual((await db.query('select * from public.raffle_entries')).rows, [{ sentinel: 'live entry' }]);
      await assert.rejects(db.query("select public.save_becoming_access_request('{}'::jsonb)"), /Production RPC must not run/);
    });
  } finally { await db.close(); }
});
