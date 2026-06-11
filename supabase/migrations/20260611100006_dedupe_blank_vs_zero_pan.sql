-- ============================================================
-- Migration: remove stale blank-PAN duplicates and normalize placeholder PANs
-- Purpose: The corrected monthly re-uploads ("…-NEW.xlsx") filled previously
--          blank Pan cells with a literal 0. Pan is the first dedupe_key
--          segment, so those rows got new keys and the upsert left the old
--          blank-PAN rows from the superseded "INCOMING CASE IN MAR - MAY
--          2026.xlsx" upload in place (4 day totals off by one vs the Excel).
--          1) Delete a blank-PAN row when a newer zero-PAN twin exists
--             (same dedupe_key apart from the leading 0).
--          2) Rewrite the surviving pan='0' rows to pan='' so they match what
--             the parser now produces (it normalizes a lone 0 to empty) and
--             re-uploads keep hitting the same dedupe_key.
-- ============================================================

delete from public.incoming_cases stale
using public.incoming_cases newer
where stale.pan = ''
  and newer.pan = '0'
  and newer.dedupe_key = '0' || stale.dedupe_key
  and newer.created_at > stale.created_at;

update public.incoming_cases c
set pan = '',
    dedupe_key = substring(dedupe_key from 2)
where c.pan = '0'
  and c.dedupe_key like '0|%'
  and not exists (
    select 1 from public.incoming_cases x
    where x.dedupe_key = substring(c.dedupe_key from 2)
  );
