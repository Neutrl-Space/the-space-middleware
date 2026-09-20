-- Run after the three Becoming Access tables from step 5.1 exist.
begin;

alter table public.becoming_access_submissions
  add column if not exists shopify_sync_status text not null default 'pending',
  add column if not exists shopify_sync_error text,
  add column if not exists shopify_synced_at timestamptz,
  add column if not exists shopify_sync_payload jsonb;

create index if not exists becoming_access_submissions_contact_idx
  on public.becoming_access_submissions(contact_id);
create index if not exists becoming_access_interests_submission_idx
  on public.becoming_access_interests(submission_id);
create index if not exists becoming_access_submissions_sync_idx
  on public.becoming_access_submissions(shopify_sync_status, created_at);

-- Customer data is accessible only through the server's service-role client.
alter table public.becoming_access_contacts enable row level security;
alter table public.becoming_access_submissions enable row level security;
alter table public.becoming_access_interests enable row level security;
revoke all on public.becoming_access_contacts, public.becoming_access_submissions,
  public.becoming_access_interests from anon, authenticated;
grant select, insert, update, delete on public.becoming_access_contacts,
  public.becoming_access_submissions, public.becoming_access_interests to service_role;

-- A failed interest insert rolls back the contact and submission together.
create or replace function public.save_becoming_access_request(request_data jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
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

  insert into public.becoming_access_contacts(name, email, phone, marketing_consent)
  values (request_data->>'name', lower(request_data->>'email'), nullif(request_data->>'phone', ''),
    coalesce((request_data->>'marketingConsent')::boolean, false))
  on conflict (email) do update set
    name = excluded.name,
    phone = coalesce(excluded.phone, becoming_access_contacts.phone),
    -- An unchecked box is not an unsubscribe request.
    marketing_consent = becoming_access_contacts.marketing_consent or excluded.marketing_consent,
    updated_at = now()
  returning id into saved_contact;

  insert into public.becoming_access_submissions(
    contact_id, campaign, utm_source, utm_medium, utm_campaign, utm_content,
    landing_page, shopify_sync_payload
  ) values (
    saved_contact, request_data->>'campaign',
    request_data->'attribution'->>'utmSource', request_data->'attribution'->>'utmMedium',
    request_data->'attribution'->>'utmCampaign', request_data->'attribution'->>'utmContent',
    request_data->'attribution'->>'landingPage', request_data->'syncPayload'
  ) returning id into saved_submission;

  insert into public.becoming_access_interests(
    submission_id, product_id, product_handle, product_title, variant_id, variant_title, selected_size
  ) select saved_submission, item->>'productId', item->>'productHandle', item->>'productTitle',
      item->>'variantId', item->>'variantTitle', item->>'selectedSize'
    from jsonb_array_elements(request_data->'interests') item;

  return jsonb_build_object('contact_id', saved_contact, 'submission_id', saved_submission);
end;
$$;
revoke all on function public.save_becoming_access_request(jsonb) from public, anon, authenticated;
grant execute on function public.save_becoming_access_request(jsonb) to service_role;
commit;
