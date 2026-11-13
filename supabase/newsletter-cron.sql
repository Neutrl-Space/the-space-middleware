-- Optional scheduler setup for the existing Supabase project, using pg_cron + pg_net.
-- Enable Cron and pg_net in the Dashboard first; pgcrypto and Vault must be available.
-- In Vault, create newsletter_middleware_url (the HTTPS origin, without /api)
-- and newsletter_cron_secret (the exact CRON_SECRET value from Vercel).
-- This creates an INACTIVE job. Do not enable it until email delivery and backend processing are ready.
begin;
do $setup$
declare
  target_url text;
  signing_secret text;
  scheduled_job bigint;
begin
  if to_regclass('cron.job') is null or to_regclass('net.http_request_queue') is null
    or to_regclass('vault.decrypted_secrets') is null
    or to_regprocedure('extensions.hmac(text,text,text)') is null then
    raise exception 'Enable Supabase Cron, pg_net, Vault and pgcrypto before running newsletter-cron.sql';
  end if;
  if exists (select 1 from cron.job where jobname = 'neutrl-newsletter-process') then
    raise exception 'Newsletter scheduler already exists. Inspect it instead of creating another job';
  end if;
  select decrypted_secret into strict target_url from vault.decrypted_secrets where name = 'newsletter_middleware_url';
  select decrypted_secret into strict signing_secret from vault.decrypted_secrets where name = 'newsletter_cron_secret';
  if target_url is null or signing_secret is null or target_url !~ '^https://[^/?#@]+/?$' or length(signing_secret) < 32 then
    raise exception 'Check the newsletter Vault secret names and values';
  end if;
  select cron.schedule('neutrl-newsletter-process', '* * * * *', $command$
    do $request$
    declare
      target_url text;
      signing_secret text;
      issued_at text;
      signature text;
    begin
      select decrypted_secret into strict target_url from vault.decrypted_secrets where name = 'newsletter_middleware_url';
      select decrypted_secret into strict signing_secret from vault.decrypted_secrets where name = 'newsletter_cron_secret';
      if target_url is null or signing_secret is null or target_url !~ '^https://[^/?#@]+/?$' or length(signing_secret) < 32 then
        raise exception 'Invalid newsletter scheduler configuration';
      end if;
      issued_at := floor(extract(epoch from clock_timestamp()))::bigint::text;
      signature := encode(extensions.hmac(
        'newsletter-worker' || chr(10) || 'GET' || chr(10) || '/api/newsletter/process' || chr(10) || issued_at,
        signing_secret, 'sha256'), 'hex');
      perform net.http_get(
        url := rtrim(target_url, '/') || '/api/newsletter/process',
        headers := jsonb_build_object('X-Newsletter-Timestamp', issued_at, 'X-Newsletter-Signature', signature),
        timeout_milliseconds := 55000
      );
    end;
    $request$;
  $command$) into scheduled_job;
  perform cron.alter_job(scheduled_job, active := false);
end;
$setup$;
commit;

-- Verify this shows active=false. Cron creation and deactivation commit atomically above.
select jobid, jobname, schedule, active from cron.job where jobname = 'neutrl-newsletter-process';
