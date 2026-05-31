-- Add a SHA-256 content hash to uploads so the upload dialog can block
-- re-uploading a workbook that already completed ingestion. The check is global
-- (any admin's prior upload) and only considers completed uploads, so a partial
-- index covering exactly that predicate keeps the lookup cheap.
--
-- No new grants or RLS: public.uploads already grants SELECT to authenticated and
-- the "uploads admin read" policy lets an admin read every row, which is what the
-- global duplicate check relies on.
alter table public.uploads add column file_hash text;

create index uploads_file_hash_completed_idx
  on public.uploads (file_hash) where status = 'completed';
