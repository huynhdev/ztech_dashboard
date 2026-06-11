-- ============================================================
-- Migration: Stuck-upload watchdog
-- Purpose: An edge-runtime kill (e.g. "CPU Time exceeded") bypasses the
--          function's catch/markFailed, leaving the upload row in
--          'pending'/'processing' forever — which also wedges the upload
--          dialog's sequential queue. Track per-row write activity and
--          provide a sweep that fails rows with no progress.
-- Affected: public.uploads (new updated_at column + trigger),
--           public.fail_stalled_uploads() (new function).
-- Special considerations: fail_stalled_uploads is SECURITY DEFINER so any
--          admin's page load can recover rows owned by other admins (the
--          uploads UPDATE policy is owner-scoped).
-- ============================================================

create extension if not exists moddatetime with schema extensions;

-- Bumped by the moddatetime trigger on every UPDATE; the edge function writes
-- progress at least once per chunk (~1s apart), so a stale updated_at on a
-- non-terminal row means the background worker died without reporting.
alter table public.uploads
  add column updated_at timestamptz not null default now();

create trigger uploads_set_updated_at
  before update on public.uploads
  for each row execute function extensions.moddatetime(updated_at);

-- Marks non-terminal uploads with no writes for p_stale_after as failed and
-- returns how many rows were swept. The longest legitimately silent window is
-- the parse phase (one status write, then nothing until total_rows lands) —
-- tens of seconds for a large workbook — so 3 minutes is a safe default.
-- A swept row is recoverable: re-uploading the file starts a fresh ingest, and
-- a stray late invocation of step 1 simply sets the row back to 'processing'.
create or replace function public.fail_stalled_uploads(
  p_stale_after interval default interval '3 minutes'
)
returns integer
language sql
security definer
set search_path = ''
as $$
  with swept as (
    update public.uploads
       set status = 'failed',
           error = 'Processing stalled: the server stopped reporting progress. Re-upload the file to retry.'
     where status in ('pending', 'processing')
       and updated_at < now() - p_stale_after
     returning 1
  )
  select count(*)::integer from swept;
$$;

comment on function public.fail_stalled_uploads(interval) is
  'Watchdog: fails pending/processing uploads whose updated_at has not moved for p_stale_after (worker died without marking the row).';

-- Admins trigger the sweep from the uploads page; is_admin() gates inside RLS
-- already, but the function itself only flips stalled rows to failed, so an
-- execute grant to authenticated is safe.
revoke execute on function public.fail_stalled_uploads(interval) from public, anon;
grant execute on function public.fail_stalled_uploads(interval) to authenticated, service_role;
