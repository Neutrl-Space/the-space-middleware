create table if not exists public.shopify_app_sessions (
  shop text primary key,
  access_token text not null,
  refresh_token text,
  scope text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shopify_app_sessions enable row level security;
