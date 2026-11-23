-- Run in the existing middleware Supabase project's SQL editor.
-- Creates test-only objects in monitoring_test. Does not alter/copy public tables,
-- production functions, customer data, app sessions, or scheduler jobs.
-- Afterwards add monitoring_test to Data API > Exposed schemas (retain existing entries).
begin;
create schema if not exists monitoring_test;
revoke all on schema monitoring_test from public, anon, authenticated;
grant usage on schema monitoring_test to service_role;

create table if not exists monitoring_test.monitoring_test_environment (
  schema_name text primary key check (schema_name = 'monitoring_test'),
  version integer not null check (version = 1)
);
create table if not exists monitoring_test.becoming_access_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique check (email ~ '^monitoring\+[a-f0-9-]{36}@example[.]com$'),
  phone text check (phone is null or phone = ''),
  marketing_consent boolean not null default false check (marketing_consent = false),
  shopify_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists monitoring_test.becoming_access_submissions (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references monitoring_test.becoming_access_contacts(id),
  campaign text not null check (campaign = 'monitoring-synthetic'),
  utm_source text, utm_medium text, utm_campaign text, utm_content text, landing_page text,
  shopify_sync_status text not null default 'pending',
  shopify_sync_error text, shopify_synced_at timestamptz, shopify_sync_payload jsonb,
  created_at timestamptz not null default now()
);
create table if not exists monitoring_test.becoming_access_interests (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references monitoring_test.becoming_access_submissions(id),
  product_id text not null, product_handle text not null, product_title text not null,
  variant_id text, variant_title text, selected_size text
);
create index if not exists becoming_access_submissions_contact_idx
  on monitoring_test.becoming_access_submissions(contact_id);
create index if not exists becoming_access_interests_submission_idx
  on monitoring_test.becoming_access_interests(submission_id);

create or replace function monitoring_test.save_becoming_access_request(request_data jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, monitoring_test
as $$
declare
  saved_contact uuid;
  saved_submission uuid;
begin
  if jsonb_typeof(request_data->'interests') is distinct from 'array' then
    raise exception 'Interests must be an array';
  end if;
  if jsonb_array_length(request_data->'interests') not between 1 and 100 then
    raise exception 'At least one interest is required';
  end if;

  insert into monitoring_test.becoming_access_contacts(name, email, phone, marketing_consent)
  values (request_data->>'name', lower(request_data->>'email'), nullif(request_data->>'phone', ''),
    coalesce((request_data->>'marketingConsent')::boolean, false))
  on conflict (email) do update set
    name = excluded.name,
    phone = coalesce(excluded.phone, becoming_access_contacts.phone),
    -- An unchecked box is not an unsubscribe request.
    marketing_consent = becoming_access_contacts.marketing_consent or excluded.marketing_consent,
    updated_at = now()
  returning id into saved_contact;

  insert into monitoring_test.becoming_access_submissions(
    contact_id, campaign, utm_source, utm_medium, utm_campaign, utm_content,
    landing_page, shopify_sync_payload
  ) values (
    saved_contact, request_data->>'campaign',
    request_data->'attribution'->>'utmSource', request_data->'attribution'->>'utmMedium',
    request_data->'attribution'->>'utmCampaign', request_data->'attribution'->>'utmContent',
    request_data->'attribution'->>'landingPage', request_data->'syncPayload'
  ) returning id into saved_submission;

  insert into monitoring_test.becoming_access_interests(
    submission_id, product_id, product_handle, product_title, variant_id, variant_title, selected_size
  ) select saved_submission, item->>'productId', item->>'productHandle', item->>'productTitle',
      item->>'variantId', item->>'variantTitle', item->>'selectedSize'
    from jsonb_array_elements(request_data->'interests') item;

  return jsonb_build_object('contact_id', saved_contact, 'submission_id', saved_submission);
end;
$$;
create table if not exists monitoring_test.raffle_entries (
  id uuid primary key default gen_random_uuid(),
  event_id text not null check (event_id = 'monitoring-synthetic'),
  request_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  entry_number integer not null check (entry_number between 100000 and 999999),
  created_at timestamptz not null default now(),
  unique(event_id, request_id),
  unique(event_id, entry_number)
);
alter table monitoring_test.raffle_entries enable row level security;
revoke all on monitoring_test.raffle_entries from anon, authenticated;
grant select, insert, update on monitoring_test.raffle_entries to service_role;
create or replace function monitoring_test.register_raffle_entry(p_event_id text, p_request_id uuid, p_name text, p_number integer)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, monitoring_test as $$
declare saved monitoring_test.raffle_entries;
begin
  select * into saved from monitoring_test.raffle_entries where event_id = p_event_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('name', saved.name, 'number', saved.entry_number);
  end if;
  -- Request-key uniqueness serializes concurrent retries; number uniqueness
  -- rejects collisions so the API can generate another candidate.
  insert into monitoring_test.raffle_entries(event_id, request_id, name, entry_number)
  values(p_event_id, p_request_id, btrim(p_name), p_number)
  on conflict(event_id, request_id) do update set request_id = excluded.request_id
  returning * into saved;
  return jsonb_build_object('name', saved.name, 'number', saved.entry_number);
end;
$$;
revoke all on function monitoring_test.register_raffle_entry(text, uuid, text, integer) from public, anon, authenticated;
grant execute on function monitoring_test.register_raffle_entry(text, uuid, text, integer) to service_role;

alter table monitoring_test.monitoring_test_environment enable row level security;
alter table monitoring_test.becoming_access_contacts enable row level security;
alter table monitoring_test.becoming_access_submissions enable row level security;
alter table monitoring_test.becoming_access_interests enable row level security;
revoke all on all tables in schema monitoring_test from public, anon, authenticated;
revoke all on all functions in schema monitoring_test from public, anon, authenticated;
grant select on monitoring_test.monitoring_test_environment to service_role;
grant select, insert, update on monitoring_test.becoming_access_contacts,
  monitoring_test.becoming_access_submissions, monitoring_test.becoming_access_interests to service_role;
grant execute on function monitoring_test.save_becoming_access_request(jsonb) to service_role;
insert into monitoring_test.monitoring_test_environment(schema_name,version)
values ('monitoring_test',1) on conflict do nothing;
notify pgrst, 'reload schema';
commit;
