begin;

create table public.newsletter_campaigns (
  shop text not null,
  campaign text not null,
  baseline_completed_at timestamptz,
  primary key (shop, campaign)
);

create table public.newsletter_events (
  shop text not null,
  event_id text not null,
  topic text not null,
  customer_id text not null,
  received_at timestamptz not null default now(),
  primary key (shop, event_id)
);

create table public.newsletter_assignments (
  id uuid primary key default gen_random_uuid(),
  shop text not null,
  campaign text not null,
  customer_id text not null,
  rules jsonb not null,
  source_event_id text,
  consent_at timestamptz,
  opt_in_level text,
  code text unique,
  starts_at timestamptz,
  ends_at timestamptz,
  discount_id text,
  status text not null default 'pending' check (status in ('pending','published','ineligible','expired','revoked','redeemed')),
  reason text,
  revocation_requested boolean not null default false,
  redeemed_order_id text,
  published_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop, campaign, customer_id),
  check ((code is null and starts_at is null and ends_at is null) or
    (code is not null and starts_at is not null and ends_at > starts_at))
);
create index newsletter_assignments_pending on public.newsletter_assignments(shop, campaign, next_attempt_at)
  where status = 'pending' or (status = 'published' and revocation_requested);

alter table public.newsletter_events enable row level security;
alter table public.newsletter_assignments enable row level security;
alter table public.newsletter_campaigns enable row level security;
revoke all on public.newsletter_events, public.newsletter_assignments, public.newsletter_campaigns from anon, authenticated;
grant select, insert, update, delete on public.newsletter_events, public.newsletter_assignments, public.newsletter_campaigns to service_role;

-- Event receipt and queue mutation are atomic. Replayed deliveries never reset a code or expiry.
create function public.enqueue_newsletter_event(event_data jsonb, campaign_name text, campaign_rules jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare inserted_count integer; launched_at timestamptz;
begin
  insert into public.newsletter_events(shop, event_id, topic, customer_id)
  values (event_data->>'shop', event_data->>'eventId', event_data->>'topic', event_data->>'customerId')
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return; end if;

  if event_data->>'kind' = 'order' then
    -- Any first order requests revocation, even when no welcome code was used.
    -- Apply across campaigns so changing the active campaign cannot strand an older offer.
    update public.newsletter_assignments a set
      revocation_requested = true,
      redeemed_order_id = case when event_data->'codes' ? a.code then event_data->>'orderId' else a.redeemed_order_id end,
      status = case when event_data->'codes' ? a.code then 'redeemed' else a.status end,
      next_attempt_at = now(), updated_at = now()
    where a.shop = event_data->>'shop' and a.customer_id = event_data->>'customerId'
      and a.status in ('pending', 'published');
    return;
  end if;

  select baseline_completed_at into launched_at from public.newsletter_campaigns
    where shop = event_data->>'shop' and campaign = campaign_name;
  if launched_at is null then raise exception 'Newsletter baseline is not complete'; end if;

  insert into public.newsletter_assignments(shop, campaign, customer_id, rules, source_event_id, consent_at, opt_in_level)
  values (event_data->>'shop', campaign_name, event_data->>'customerId', campaign_rules || jsonb_build_object('launchedAt', launched_at),
    event_data->>'eventId', (event_data->>'consentAt')::timestamptz, event_data->>'optInLevel')
  on conflict (shop, campaign, customer_id) do update set
    status = 'pending', reason = null, next_attempt_at = now(), updated_at = now(),
    source_event_id = excluded.source_event_id, consent_at = excluded.consent_at, opt_in_level = excluded.opt_in_level
  -- A later confirmed opt-in can revive an unrelated customer-created candidate.
  -- Existing-subscriber baseline records and previously assigned offers never revive.
  where newsletter_assignments.code is null and newsletter_assignments.status = 'ineligible'
    and newsletter_assignments.reason in ('missing_source', 'not_subscribed')
    and event_data->>'topic' = 'customers_email_marketing_consent/update';
end;
$$;

create function public.claim_newsletter_job(shop_domain text, campaign_name text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare claimed public.newsletter_assignments;
begin
  select * into claimed from public.newsletter_assignments
  where shop = shop_domain
    and (campaign = campaign_name or revocation_requested)
    and (status = 'pending' or (status = 'published' and revocation_requested))
    and next_attempt_at <= now() and (lease_until is null or lease_until < now())
  order by revocation_requested desc, next_attempt_at, created_at
  for update skip locked limit 1;
  if not found then return null; end if;
  update public.newsletter_assignments set lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes',
    attempts = attempts + 1, updated_at = now()
  where id = claimed.id returning * into claimed;
  return to_jsonb(claimed);
end;
$$;

create function public.finish_newsletter_job(job_id uuid, token uuid, changes jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare current_job public.newsletter_assignments;
begin
  select * into current_job from public.newsletter_assignments where id = job_id and lease_token = token for update;
  if not found then raise exception 'Newsletter lease lost'; end if;
  update public.newsletter_assignments set
    status = case
      when current_job.redeemed_order_id is not null then 'redeemed'
      when current_job.revocation_requested and changes->>'status' = 'published' then 'pending'
      else changes->>'status' end,
    reason = changes->>'reason',
    discount_id = coalesce(changes->>'discount_id', current_job.discount_id),
    published_at = coalesce((changes->>'published_at')::timestamptz, current_job.published_at),
    lease_token = null, lease_until = null,
    next_attempt_at = case when changes->>'status' = 'pending'
      then now() + make_interval(secs => least(3600, (60 * power(2, least(current_job.attempts - 1, 6)))::integer))
      else now() end,
    updated_at = now()
  where id = job_id;
end;
$$;

revoke all on function public.enqueue_newsletter_event(jsonb,text,jsonb),
  public.claim_newsletter_job(text,text), public.finish_newsletter_job(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_newsletter_event(jsonb,text,jsonb),
  public.claim_newsletter_job(text,text), public.finish_newsletter_job(uuid,uuid,jsonb) to service_role;

commit;
