-- Supporting migration for the event_orders table already created in step 3.5.
-- Run before enabling reservations. Does not recreate, truncate, or drop event_orders.
begin;

create sequence if not exists public.popup_reservation_code_seq as bigint start with 1;

create or replace function public.next_popup_reservation_code()
returns text
language plpgsql
set search_path = ''
as $$
declare
  number_text text;
begin
  number_text := nextval('public.popup_reservation_code_seq'::regclass)::text;
  return 'NS-' || lpad(number_text, greatest(4, length(number_text)), '0');
end;
$$;

-- Internal request ledger; event_orders remains the main event workflow table.
create table if not exists public.popup_reservation_requests (
  request_id uuid primary key,
  fingerprint text not null,
  status text not null check (status in ('processing', 'order_created', 'confirmed', 'rejected', 'review_required')),
  shopify_order_id text unique,
  response jsonb,
  review_stage text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.popup_reservation_requests
  add column if not exists reservation_code text,
  add column if not exists inventory_evidence jsonb,
  add column if not exists sms_consent_text text,
  add column if not exists sms_consent_at timestamptz,
  add column if not exists sms_status text not null default 'deferred',
  add column if not exists sms_provider_id text;

-- Continue past existing NS codes and never rewind the sequence when rerun.
-- Gaps after rejected requests are expected; allocation is safe across concurrent requests.
select setval('public.popup_reservation_code_seq', greatest(
  (select last_value + case when is_called then 1 else 0 end from public.popup_reservation_code_seq),
  coalesce((select max(substring(reservation_code from 4)::bigint) + 1
    from public.event_orders where reservation_code ~ '^NS-[0-9]+$'), 1),
  coalesce((select max(substring(reservation_code from 4)::bigint) + 1
    from public.popup_reservation_requests where reservation_code ~ '^NS-[0-9]+$'), 1)
), false);

alter table public.popup_reservation_requests
  alter column reservation_code set default public.next_popup_reservation_code();
update public.popup_reservation_requests
  set reservation_code = public.next_popup_reservation_code()
  where reservation_code is null;
alter table public.popup_reservation_requests alter column reservation_code set not null;
create unique index if not exists popup_reservation_requests_code_unique
  on public.popup_reservation_requests(reservation_code);

-- Keep workflow/customer records and the request ledger server-only.
alter table public.event_orders enable row level security;
alter table public.popup_reservation_requests enable row level security;
revoke all on public.event_orders, public.popup_reservation_requests from anon, authenticated;
grant all on public.event_orders, public.popup_reservation_requests to service_role;
revoke all on sequence public.popup_reservation_code_seq from public, anon, authenticated;
grant usage, select on sequence public.popup_reservation_code_seq to service_role;
revoke all on function public.next_popup_reservation_code() from public, anon, authenticated;
grant execute on function public.next_popup_reservation_code() to service_role;

commit;
