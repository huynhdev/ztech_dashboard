-- ============================================================
-- Migration: Incoming-case domain tables + upload ingestion tracking
-- Purpose: Store normalized dental-lab cases ingested from uploaded
--          .xlsx workbooks, plus an uploads table tracking ingestion
--          progress (driven by an edge function, surfaced via Realtime).
-- Affected: public.labs, public.products, public.doctors,
--           public.patients, public.uploads, public.incoming_cases,
--           public.upload_status enum, storage bucket 'uploads'.
-- Special considerations: admin-only access via public.is_admin();
--          explicit Data API grants required (new tables are not
--          auto-exposed); uploads added to supabase_realtime publication.
-- ============================================================

-- ---------- enum: upload lifecycle ----------
create type public.upload_status as enum ('pending', 'processing', 'completed', 'failed');

-- ---------- labs ----------
create table public.labs (
  id bigint generated always as identity primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);
comment on table public.labs is 'Dental labs (clients), resolved by name from uploads.';

-- ---------- products ----------
create table public.products (
  id bigint generated always as identity primary key,
  name text not null unique,
  category text,
  created_at timestamptz not null default now()
);
comment on table public.products is 'Product catalog; category derived from the name prefix.';

-- ---------- doctors ----------
create table public.doctors (
  id bigint generated always as identity primary key,
  name text not null,
  route text,
  raw text not null unique,
  lab_id bigint references public.labs (id),
  created_at timestamptz not null default now()
);
comment on table public.doctors is 'Doctors, resolved by their raw "Name - RTE: X" string.';

-- ---------- patients ----------
create table public.patients (
  id bigint generated always as identity primary key,
  name text not null,
  external_id text,
  lab_id bigint references public.labs (id),
  created_at timestamptz not null default now(),
  -- nulls not distinct so patients without an external_id still de-dupe
  constraint patients_natural_key unique nulls not distinct (name, external_id, lab_id)
);
comment on table public.patients is 'Patients, unique per (name, external_id, lab).';

-- ---------- uploads (tracking; referenced by incoming_cases) ----------
create table public.uploads (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_path text,
  status public.upload_status not null default 'pending',
  total_rows integer,
  processed_rows integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  new_labs_count integer not null default 0,
  new_doctors_count integer not null default 0,
  error text,
  -- set null (not the default restrict) so deleting a user — which cascades from
  -- auth.users to profiles — doesn't get blocked by historical uploads; the audit
  -- row survives with uploaded_by = null.
  uploaded_by uuid references public.profiles (id) on delete set null,
  uploaded_at timestamptz not null default now()
);
comment on table public.uploads is 'Tracks each uploaded workbook and its ingestion progress.';
create index uploads_uploaded_at_idx on public.uploads (uploaded_at desc);

-- ---------- incoming_cases ----------
create table public.incoming_cases (
  id bigint generated always as identity primary key,
  pan text,
  patient_id bigint references public.patients (id),
  lab_id bigint references public.labs (id),
  doctor_id bigint references public.doctors (id),
  product_id bigint references public.products (id),
  order_date date not null,
  status text,
  amount numeric not null default 0,
  is_multi_unit boolean not null default false,
  source_file text,
  upload_id uuid references public.uploads (id),
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);
comment on table public.incoming_cases is 'Normalized incoming cases; dedupe_key makes re-ingest idempotent.';
comment on column public.incoming_cases.dedupe_key is 'pan|order_date|patient_id|product_id (null components render as empty string)';
create index incoming_cases_order_date_idx on public.incoming_cases (order_date);
create index incoming_cases_lab_id_idx on public.incoming_cases (lab_id);
create index incoming_cases_product_id_idx on public.incoming_cases (product_id);
create index incoming_cases_doctor_id_idx on public.incoming_cases (doctor_id);
create index incoming_cases_patient_id_idx on public.incoming_cases (patient_id);
create index incoming_cases_upload_id_idx on public.incoming_cases (upload_id);

-- ============================================================
-- Data API grants (new public tables are not auto-exposed).
-- authenticated: read-only (all writes go through the service-role
-- edge function) EXCEPT uploads, which the client inserts/updates.
-- service_role: full (the edge function bypasses RLS but still needs grants).
-- ============================================================
grant select on public.labs, public.products, public.doctors, public.patients, public.incoming_cases to authenticated;
grant select, insert, update, delete on public.labs, public.products, public.doctors, public.patients, public.incoming_cases to service_role;

grant select, insert, update on public.uploads to authenticated;
grant select, insert, update, delete on public.uploads to service_role;

-- identity columns advance their sequences internally on insert; grant for safety.
-- NOTE: `all sequences in schema` is a point-in-time snapshot — any FUTURE migration
-- that adds identity tables must re-run this grant for those new sequences.
grant usage, select on all sequences in schema public to service_role;

-- ============================================================
-- Row Level Security: admin-only (mirrors profiles).
-- ============================================================
alter table public.labs enable row level security;
alter table public.products enable row level security;
alter table public.doctors enable row level security;
alter table public.patients enable row level security;
alter table public.incoming_cases enable row level security;
alter table public.uploads enable row level security;

-- domain tables: admins may read (writes happen via service_role / RLS-bypass)
create policy "labs admin read" on public.labs for select to authenticated using ( public.is_admin() );
create policy "products admin read" on public.products for select to authenticated using ( public.is_admin() );
create policy "doctors admin read" on public.doctors for select to authenticated using ( public.is_admin() );
create policy "patients admin read" on public.patients for select to authenticated using ( public.is_admin() );
create policy "incoming_cases admin read" on public.incoming_cases for select to authenticated using ( public.is_admin() );

-- uploads: admins read all, insert their own, and update (file_path / retries)
create policy "uploads admin read" on public.uploads
  for select to authenticated using ( public.is_admin() );
create policy "uploads admin insert" on public.uploads
  for insert to authenticated with check ( public.is_admin() and uploaded_by = (select auth.uid()) );
create policy "uploads admin update" on public.uploads
  for update to authenticated using ( public.is_admin() ) with check ( public.is_admin() );

-- ============================================================
-- Storage: private 'uploads' bucket, admin-only objects.
-- ============================================================
insert into storage.buckets (id, name, public)
  values ('uploads', 'uploads', false)
  on conflict (id) do nothing;

create policy "uploads bucket admin read" on storage.objects
  for select to authenticated using ( bucket_id = 'uploads' and public.is_admin() );
create policy "uploads bucket admin insert" on storage.objects
  for insert to authenticated with check ( bucket_id = 'uploads' and public.is_admin() );

-- ============================================================
-- Realtime: stream uploads row updates to the client.
-- ============================================================
alter table public.uploads replica identity full;
alter publication supabase_realtime add table public.uploads;
