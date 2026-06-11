-- ============================================================
-- Migration: import_upload_chunk() — carry is_redo through ingestion
-- Purpose: Extend the chunk-ingestion RPC to read the parser's new `isRedo`
--          flag and persist it on incoming_cases.is_redo. Everything else is
--          identical to 20260531085520_import_upload_chunk.sql; redo is a
--          per-row passthrough, idempotent on dedupe_key.
-- ============================================================

create or replace function public.import_upload_chunk(
  p_upload_id uuid,
  p_source_file text,
  p_rows jsonb
)
returns table (
  inserted_count int,
  updated_count int,
  new_labs_count int,
  new_doctors_count int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted int := 0;
  v_updated int := 0;
  v_new_labs int := 0;
  v_new_doctors int := 0;
begin
  create temporary table _chunk_rows on commit drop as
  select
    row_number() over () as rn,
    r.pan,
    r."patientName" as patient_name,
    r."externalId" as external_id,
    r.lab,
    r."doctorName" as doctor_name,
    r.route,
    r."doctorRaw" as doctor_raw,
    (r."orderDate")::date as order_date,
    r."orderDate" as order_date_str,
    r."productName" as product_name,
    r.category,
    coalesce(r."isMultiUnit", false) as is_multi_unit,
    r.status,
    coalesce(r.amount, 0) as amount,
    coalesce(r."isRedo", false) as is_redo
  from jsonb_to_recordset(p_rows) as r(
    pan text,
    "patientName" text,
    "externalId" text,
    lab text,
    "doctorName" text,
    route text,
    "doctorRaw" text,
    "orderDate" text,
    "productName" text,
    category text,
    "isMultiUnit" boolean,
    status text,
    amount numeric,
    "isRedo" boolean
  );

  -- ---------- dimensions: insert any new values, count brand-new labs/doctors ----------
  with ins as (
    insert into labs (name)
    select distinct lab from _chunk_rows where lab is not null
    on conflict (name) do nothing
    returning 1
  )
  select count(*) into v_new_labs from ins;

  insert into products (name, category)
  select distinct on (product_name) product_name, category
  from _chunk_rows
  where product_name is not null
  order by product_name, rn
  on conflict (name) do nothing;

  with ins as (
    insert into doctors (raw, name, route, lab_id)
    select distinct on (d.doctor_raw) d.doctor_raw, d.doctor_name, d.route, l.id
    from _chunk_rows d
    join labs l on l.name = d.lab
    where d.doctor_raw is not null
    order by d.doctor_raw, d.rn
    on conflict (raw) do nothing
    returning 1
  )
  select count(*) into v_new_doctors from ins;

  insert into patients (name, external_id, lab_id)
  select distinct on (p.patient_name, p.external_id, l.id)
    p.patient_name, p.external_id, l.id
  from _chunk_rows p
  join labs l on l.name = p.lab
  on conflict on constraint patients_natural_key do nothing;

  -- ---------- resolve ids + build deduped case rows ----------
  create temporary table _chunk_cases on commit drop as
  select distinct on (dedupe_key) *
  from (
    select
      r.rn,
      r.pan,
      pt.id as patient_id,
      l.id as lab_id,
      doc.id as doctor_id,
      prod.id as product_id,
      r.order_date,
      r.status,
      r.amount,
      r.is_multi_unit,
      r.is_redo,
      r.pan || '|' || r.order_date_str || '|' || pt.id::text || '|' || prod.id::text as dedupe_key
    from _chunk_rows r
    join labs l on l.name = r.lab
    join products prod on prod.name = r.product_name
    join doctors doc on doc.raw = r.doctor_raw
    join patients pt
      on pt.name = r.patient_name
     and pt.lab_id = l.id
     and pt.external_id is not distinct from r.external_id
  ) s
  order by dedupe_key, rn desc;

  select
    count(*) filter (where ic.id is null),
    count(*) filter (where ic.id is not null)
  into v_inserted, v_updated
  from _chunk_cases c
  left join incoming_cases ic on ic.dedupe_key = c.dedupe_key;

  insert into incoming_cases (
    pan, patient_id, lab_id, doctor_id, product_id, order_date,
    status, amount, is_multi_unit, is_redo, source_file, upload_id, dedupe_key
  )
  select
    c.pan, c.patient_id, c.lab_id, c.doctor_id, c.product_id, c.order_date,
    c.status, c.amount, c.is_multi_unit, c.is_redo, p_source_file, p_upload_id, c.dedupe_key
  from _chunk_cases c
  on conflict (dedupe_key) do update set
    pan = excluded.pan,
    patient_id = excluded.patient_id,
    lab_id = excluded.lab_id,
    doctor_id = excluded.doctor_id,
    product_id = excluded.product_id,
    order_date = excluded.order_date,
    status = excluded.status,
    amount = excluded.amount,
    is_multi_unit = excluded.is_multi_unit,
    is_redo = excluded.is_redo,
    source_file = excluded.source_file,
    upload_id = excluded.upload_id;

  inserted_count := v_inserted;
  updated_count := v_updated;
  new_labs_count := v_new_labs;
  new_doctors_count := v_new_doctors;
  return next;
end;
$$;

comment on function public.import_upload_chunk(uuid, text, jsonb) is
  'Ingests one chunk of parsed upload rows: upserts lab/product/doctor/patient dimensions then incoming_cases (idempotent on dedupe_key, incl. is_redo). Returns per-chunk counts. Called by the process-upload edge function via rpc().';

revoke all on function public.import_upload_chunk(uuid, text, jsonb) from public;
grant execute on function public.import_upload_chunk(uuid, text, jsonb) to service_role;
