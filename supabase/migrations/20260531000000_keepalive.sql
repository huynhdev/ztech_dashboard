-- Keep-alive: prevent Supabase project auto-pause via daily write activity.
-- A pg_cron job calls an edge function once a day, which upserts into the
-- keepalive table to register write activity.

-- Required extensions
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Activity-tracking table (single row, updated each ping)
create table if not exists public.keepalive (
  id integer primary key,
  pinged_at timestamptz not null default now()
);

-- Deny all public access; only the postgres/pg_cron role (and the edge
-- function's secret key, which bypasses RLS) writes to this table.
alter table public.keepalive enable row level security;

-- Invoke the keepalive edge function via HTTP POST from Postgres.
create or replace function public.invoke_keepalive_edge_function()
returns void
language plpgsql
security definer
as $$
declare
  base_url text;
  publishable_key text;
begin
  -- Project URL and publishable key are stored in Vault.
  select decrypted_secret into base_url
    from vault.decrypted_secrets
    where name = 'project_url';

  select decrypted_secret into publishable_key
    from vault.decrypted_secrets
    where name = 'publishable_key';

  perform net.http_post(
    url := base_url || '/functions/v1/keepalive',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-api-key', 'ztech-keepalive-2026',
      'apikey', publishable_key
    ),
    body := jsonb_build_object('source', 'pg_cron', 'time', now()),
    timeout_milliseconds := 5000
  );
end;
$$;

-- Daily keep-alive job at midnight UTC.
select cron.schedule(
  'keep-alive',
  '0 0 * * *',
  $$select public.invoke_keepalive_edge_function()$$
);
