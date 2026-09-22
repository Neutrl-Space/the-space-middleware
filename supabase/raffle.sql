begin;
create table if not exists public.raffle_entries (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  request_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  entry_number integer not null check (entry_number between 100000 and 999999),
  created_at timestamptz not null default now(),
  unique(event_id, request_id),
  unique(event_id, entry_number)
);
alter table public.raffle_entries enable row level security;
revoke all on public.raffle_entries from anon, authenticated;
grant select, insert, update on public.raffle_entries to service_role;
create or replace function public.register_raffle_entry(p_event_id text, p_request_id uuid, p_name text, p_number integer)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare saved public.raffle_entries;
begin
  select * into saved from public.raffle_entries where event_id = p_event_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('name', saved.name, 'number', saved.entry_number);
  end if;
  -- Request-key uniqueness serializes concurrent retries; number uniqueness
  -- rejects collisions so the API can generate another candidate.
  insert into public.raffle_entries(event_id, request_id, name, entry_number)
  values(p_event_id, p_request_id, btrim(p_name), p_number)
  on conflict(event_id, request_id) do update set request_id = excluded.request_id
  returning * into saved;
  return jsonb_build_object('name', saved.name, 'number', saved.entry_number);
end;
$$;
revoke all on function public.register_raffle_entry(text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.register_raffle_entry(text, uuid, text, integer) to service_role;
commit;
