-- Apply after newsletter.sql. Existing reservations retain their original expiry.
begin;

create table public.newsletter_status_limits (
  key text primary key,
  window_start timestamptz not null,
  requests integer not null
);
alter table public.newsletter_status_limits enable row level security;
revoke all on public.newsletter_status_limits from anon, authenticated;
grant select, insert, update, delete on public.newsletter_status_limits to service_role;

create function public.allow_newsletter_status(client_key text, token_key text)
returns boolean language plpgsql security invoker set search_path = public as $$
declare bucket text; hits integer; permitted boolean := true;
begin
  delete from public.newsletter_status_limits where window_start < now() - interval '1 day';
  foreach bucket in array array['client:' || client_key, 'token:' || token_key] loop
    insert into public.newsletter_status_limits as limits(key, window_start, requests)
      values(bucket, date_trunc('minute', now()), 1)
    on conflict (key) do update set
      requests = case when limits.window_start = excluded.window_start then limits.requests + 1 else 1 end,
      window_start = excluded.window_start
    returning requests into hits;
    if hits > 30 then permitted := false; end if;
  end loop;
  return permitted;
end;
$$;

-- Targeted claims let a verified signup issue its own offer without draining other customers' jobs.
create function public.claim_newsletter_customer_job(shop_domain text, campaign_name text, customer_gid text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare claimed public.newsletter_assignments;
begin
  select * into claimed from public.newsletter_assignments
    where shop = shop_domain and campaign = campaign_name and customer_id = customer_gid
      and status = 'pending' and not revocation_requested and redeemed_order_id is null
      and next_attempt_at <= now() and (lease_until is null or lease_until < now())
    for update skip locked limit 1;
  if not found then return null; end if;
  update public.newsletter_assignments set lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes',
    attempts = attempts + 1, updated_at = now() where id = claimed.id returning * into claimed;
  return to_jsonb(claimed);
end;
$$;

alter table public.newsletter_assignments
  add column reminder_status text not null default 'pending' check (reminder_status in ('pending', 'published', 'skipped')),
  add column reminder_lease_token uuid,
  add column reminder_lease_until timestamptz,
  add column reminder_attempts integer not null default 0,
  add column reminder_next_attempt_at timestamptz not null default now(),
  add column reminder_published_at timestamptz,
  add column reminder_reason text;
create index newsletter_reminders_due on public.newsletter_assignments(shop, campaign, starts_at)
  where status = 'published' and reminder_status = 'pending';

create function public.claim_newsletter_reminder(shop_domain text, campaign_name text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare claimed public.newsletter_assignments;
begin
  select * into claimed from public.newsletter_assignments
    where shop = shop_domain and campaign = campaign_name and status = 'published'
      and reminder_status = 'pending' and not revocation_requested and redeemed_order_id is null
      and (rules->>'validityDays')::integer = 1
      and starts_at + interval '12 hours' <= now()
      and reminder_next_attempt_at <= now()
      and (reminder_lease_until is null or reminder_lease_until < now())
    order by starts_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.newsletter_assignments set reminder_lease_token = gen_random_uuid(),
    reminder_lease_until = now() + interval '5 minutes', reminder_attempts = reminder_attempts + 1
    where id = claimed.id returning * into claimed;
  return to_jsonb(claimed);
end;
$$;

create function public.finish_newsletter_reminder(job_id uuid, token uuid, outcome text, explanation text)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if outcome not in ('pending', 'published', 'skipped') then raise exception 'Invalid reminder outcome'; end if;
  update public.newsletter_assignments set reminder_status = outcome, reminder_reason = explanation,
    reminder_published_at = case when outcome = 'published' then now() else reminder_published_at end,
    reminder_next_attempt_at = now() + make_interval(secs => least(3600, (60 * power(2, least(reminder_attempts - 1, 6)))::integer)),
    reminder_lease_token = null, reminder_lease_until = null
    where id = job_id and reminder_lease_token = token;
  if not found then raise exception 'Newsletter reminder lease lost'; end if;
end;
$$;

revoke all on function public.allow_newsletter_status(text,text), public.claim_newsletter_customer_job(text,text,text),
  public.claim_newsletter_reminder(text,text), public.finish_newsletter_reminder(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.allow_newsletter_status(text,text), public.claim_newsletter_customer_job(text,text,text),
  public.claim_newsletter_reminder(text,text), public.finish_newsletter_reminder(uuid,uuid,text,text) to service_role;
commit;
