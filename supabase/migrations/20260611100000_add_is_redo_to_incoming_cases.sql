-- ============================================================
-- Migration: add incoming_cases.is_redo
-- Purpose: Track whether a case is a "redo" (rework). The source export marks
--          these with a "REDO" column (value 1) or an "R" column (value 'R');
--          the parser now emits an `isRedo` flag per row. Existing rows default
--          to false until their source file is re-uploaded.
-- ============================================================

alter table public.incoming_cases
  add column if not exists is_redo boolean not null default false;

comment on column public.incoming_cases.is_redo is
  'True when the source row was flagged as a redo/rework case (REDO=1 or R=''R'').';
