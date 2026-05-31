# XLSX Upload → Supabase Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload an incoming-cases `.xlsx` workbook that is parsed and stored (normalized) into Supabase, with real-time ingestion progress and a Supabase-backed upload history.

**Architecture:** Approach B — the browser uploads the file to a private Storage bucket and inserts an `uploads` tracking row, then invokes a Deno Edge Function (`process-upload`) which parses the workbook with SheetJS, resolves/normalizes labs/doctors/patients/products, and idempotently upserts `incoming_cases`. The function updates the `uploads` row's progress columns as it works; the client subscribes to those updates via Supabase Realtime. Dashboard **analytics** stay JSON-backed (out of scope); only the **upload history** read moves to Supabase.

**Tech Stack:** Next.js 16 / React 19, Supabase (Postgres + Storage + Realtime + Edge Functions/Deno), SheetJS (`xlsx`, Deno via CDN ESM), shadcn/ui, TypeScript.

**Spec:** `docs/superpowers/specs/2026-05-31-xlsx-upload-ingestion-design.md`

---

## File Structure

**Create**
- `supabase/migrations/20260531020000_create_incoming_cases.sql` — domain tables, `uploads`, enum, indexes, grants, RLS, storage bucket, realtime publication.
- `supabase/functions/process-upload/parse.ts` — pure workbook→rows parser (unit-tested).
- `supabase/functions/process-upload/parse.test.ts` — Deno unit tests for the parser.
- `supabase/functions/process-upload/index.ts` — HTTP entry + ingestion (I/O, entity resolution, upserts, progress updates).

**Modify**
- `supabase/config.toml` — register `[functions.process-upload]`.
- `lib/data.ts` — replace JSON-backed `Upload` type + `getUploads()` with async Supabase reads. (Leave all analytics functions and JSON imports untouched.)
- `components/upload-columns.tsx` — add `"pending"` status, uploader/progress columns for the new shape.
- `app/(dashboard)/upload/page.tsx` — `await getUploads()`.
- `components/upload-dialog.tsx` — single-`.xlsx`, real `handleUpload` (insert→storage→invoke→Realtime), live progress UI.
- `types/database.ts` — regenerated (not hand-edited).

**Untouched (explicitly):** `app/(dashboard)/page.tsx`, `components/client-heatmap.tsx`, `components/client-change-table.tsx`, all analytics functions in `lib/data.ts`, `data/*.json`.

---

## Task 1: Database migration (schema, RLS, storage, realtime)

**Files:**
- Create: `supabase/migrations/20260531020000_create_incoming_cases.sql`

Reference the `supabase` skill conventions and the existing `supabase/migrations/20260531010000_create_profiles.sql` (uses `public.is_admin()`).

- [ ] **Step 1: Write the migration**

```sql
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
  uploaded_by uuid references public.profiles (id),
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
comment on column public.incoming_cases.dedupe_key is 'pan|order_date|patient_id|product_id';
create index incoming_cases_order_date_idx on public.incoming_cases (order_date);
create index incoming_cases_lab_id_idx on public.incoming_cases (lab_id);
create index incoming_cases_product_id_idx on public.incoming_cases (product_id);
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

-- identity columns advance their sequences internally on insert; grant for safety
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
```

- [ ] **Step 2: Apply the migration locally**

Run: `yarn db:migrate`
Expected: applies `20260531020000_create_incoming_cases.sql` with no errors.

- [ ] **Step 3: Regenerate types**

Run: `yarn db:gen-types`
Expected: `types/database.ts` now contains `labs`, `products`, `doctors`, `patients`, `uploads`, `incoming_cases` tables and the `upload_status` enum.

- [ ] **Step 4: Verify schema sanity**

Run: `yarn db:reset` (rebuilds from scratch to confirm the migration is replayable)
Expected: completes; all migrations apply cleanly.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260531020000_create_incoming_cases.sql types/database.ts
git commit -m "feat(db): incoming-case domain tables + uploads tracking, RLS, storage, realtime"
```

---

## Task 2: Workbook parser (pure, TDD)

Pure module so it is unit-testable without Supabase or storage. No PII fixture is committed — the test builds a synthetic workbook in memory that mirrors the real multi-sheet layout.

**Files:**
- Create: `supabase/functions/process-upload/parse.ts`
- Test: `supabase/functions/process-upload/parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/process-upload/parse.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
import { parseWorkbook } from "./parse.ts";

function buildWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new();

  // pivot-style sheet that MUST be ignored (no full header match)
  const pivot = XLSX.utils.aoa_to_sheet([
    ["Count of Product", "Column Labels"],
    ["Row Labels", new Date(Date.UTC(2026, 4, 11))],
    ["123 Dental", 1],
  ]);
  XLSX.utils.book_append_sheet(wb, pivot, "Sheet1");

  // detail sheet: title row + blanks + header at row index 3 + data rows
  const detail = XLSX.utils.aoa_to_sheet(
    [
      ["INCOMING CASE - ZTECH", null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null, null],
      ["No", "Pan", "Patient", "Lab", "Doctor", "Order date", "Product", "Status", "Amount"],
      [1, "Z172", "JILL SHELTON", "123 Dental", "Le, Tommy DDS - RTE: A", new Date(Date.UTC(2026, 4, 11)), "Zirconia - Multilayer Veneer...", "Shipped", 430.65],
      [2, "R209", "THUY DOAN #3653", "21 Dental Group", "Vo, Ngoc Lan DDS - RTE: JES", new Date(Date.UTC(2026, 4, 13)), "Implant - Abutment CUSTOM Titanium", "In Production", 0],
      [3, "", "", "", "", null, "", "", null], // missing patient/lab/date -> skipped
    ],
    { cellDates: true },
  );
  XLSX.utils.book_append_sheet(wb, detail, "MAY 11 - 17.2026");

  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

Deno.test("parses the detail sheet, ignores pivots, extracts entities", () => {
  const { rows, skipped } = parseWorkbook(buildWorkbook());

  assertEquals(rows.length, 2);
  assertEquals(skipped.length, 1);

  assertEquals(rows[0].lab, "123 Dental");
  assertEquals(rows[0].doctorName, "Le, Tommy DDS");
  assertEquals(rows[0].route, "A");
  assertEquals(rows[0].category, "Zirconia");
  assertEquals(rows[0].isMultiUnit, true);
  assertEquals(rows[0].orderDate, "2026-05-11");
  assertEquals(rows[0].amount, 430.65);

  assertEquals(rows[1].patientName, "THUY DOAN");
  assertEquals(rows[1].externalId, "3653");
  assertEquals(rows[1].route, "JES");
  assertEquals(rows[1].isMultiUnit, false);
  assertEquals(rows[1].amount, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test supabase/functions/process-upload/parse.test.ts --allow-net`
Expected: FAIL — `parse.ts` / `parseWorkbook` does not exist yet.
(`--allow-net` is needed because XLSX is imported from the SheetJS CDN. If `deno` is not on PATH, use the Deno bundled with the Supabase CLI or install Deno.)

- [ ] **Step 3: Implement the parser**

```ts
// supabase/functions/process-upload/parse.ts
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";

export interface ParsedRow {
  pan: string;
  patientName: string;
  externalId: string | null;
  lab: string;
  doctorName: string;
  route: string | null;
  doctorRaw: string;
  orderDate: string; // YYYY-MM-DD
  productName: string;
  category: string;
  isMultiUnit: boolean;
  status: string;
  amount: number;
}

export interface SkippedRow {
  reason: string;
  raw: unknown;
}

export interface ParseResult {
  rows: ParsedRow[];
  skipped: SkippedRow[];
}

const HEADER_KEYS = ["pan", "patient", "lab", "doctor", "order date", "product", "status", "amount"];

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function toDateString(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

function parsePatient(raw: string): { name: string; externalId: string | null } {
  const m = raw.match(/^(.*?)\s*#\s*(\S+)\s*$/);
  return m ? { name: m[1].trim(), externalId: m[2].trim() } : { name: raw.trim(), externalId: null };
}

function parseDoctor(raw: string): { name: string; route: string | null } {
  const m = raw.match(/^(.*?)\s*-\s*RTE:\s*(\S+)\s*$/i);
  return m ? { name: m[1].trim(), route: m[2].trim() } : { name: raw.trim(), route: null };
}

function parseProduct(raw: string): { name: string; category: string; isMultiUnit: boolean } {
  const name = raw.trim();
  const isMultiUnit = /\.\.\.\s*$/.test(name);
  const i = name.indexOf(" - ");
  const category = i >= 0 ? name.slice(0, i).trim() : name;
  return { name, category, isMultiUnit };
}

export function parseWorkbook(bytes: Uint8Array): ParseResult {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });

  for (const sheetName of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: null,
    }) as unknown[][];

    const headerIdx = matrix.findIndex((row) => {
      const cells = (row ?? []).map(norm);
      return HEADER_KEYS.every((k) => cells.some((c) => c === k || c.startsWith(k)));
    });
    if (headerIdx === -1) continue;

    const header = matrix[headerIdx].map(norm);
    const col = (key: string) => header.findIndex((c) => c === key || c.startsWith(key));
    const idx = {
      pan: col("pan"),
      patient: col("patient"),
      lab: col("lab"),
      doctor: col("doctor"),
      orderDate: col("order date"),
      product: col("product"),
      status: col("status"),
      amount: col("amount"),
    };

    const rows: ParsedRow[] = [];
    const skipped: SkippedRow[] = [];

    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const r = matrix[i];
      if (!r || r.every((c) => c === null || String(c).trim() === "")) continue;

      const patientCell = String(r[idx.patient] ?? "").trim();
      const lab = String(r[idx.lab] ?? "").trim();
      const orderDate = toDateString(r[idx.orderDate]);
      if (!patientCell || !lab || !orderDate) {
        skipped.push({ reason: "missing patient/lab/order_date", raw: r });
        continue;
      }

      const { name: patientName, externalId } = parsePatient(patientCell);
      const doctorRaw = String(r[idx.doctor] ?? "").trim();
      const { name: doctorName, route } = parseDoctor(doctorRaw);
      const { name: productName, category, isMultiUnit } = parseProduct(String(r[idx.product] ?? "").trim());
      const amountNum = Number(r[idx.amount] ?? 0);

      rows.push({
        pan: String(r[idx.pan] ?? "").trim(),
        patientName,
        externalId,
        lab,
        doctorName,
        route,
        doctorRaw,
        orderDate,
        productName,
        category,
        isMultiUnit,
        status: String(r[idx.status] ?? "").trim(),
        amount: Number.isFinite(amountNum) ? amountNum : 0,
      });
    }

    return { rows, skipped };
  }

  return { rows: [], skipped: [{ reason: "no detail sheet found", raw: wb.SheetNames }] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test supabase/functions/process-upload/parse.test.ts --allow-net`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-upload/parse.ts supabase/functions/process-upload/parse.test.ts
git commit -m "feat(ingest): pure xlsx workbook parser with unit tests"
```

---

## Task 3: Edge function ingestion (`process-upload`)

**Files:**
- Create: `supabase/functions/process-upload/index.ts`
- Modify: `supabase/config.toml`

- [ ] **Step 1: Register the function in config.toml**

Append near the existing `[functions.keepalive]` block:

```toml
[functions.process-upload]
verify_jwt = true
```

- [ ] **Step 2: Implement the function**

```ts
// supabase/functions/process-upload/index.ts
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { parseWorkbook } from "./parse.ts";

// Supabase runtime global (not in Deno's default lib types).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROGRESS_EVERY = 50;

Deno.serve(async (req) => {
  let uploadId: string | null = null;
  try {
    ({ uploadId } = await req.json());
  } catch {
    uploadId = null;
  }
  if (!uploadId) {
    return Response.json({ error: "uploadId required" }, { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  // process in the background; return immediately so the client just watches Realtime
  EdgeRuntime.waitUntil(ingest(admin, uploadId));
  return Response.json({ accepted: true, uploadId }, { status: 202 });
});

async function ingest(admin: SupabaseClient, uploadId: string): Promise<void> {
  try {
    const { data: upload, error } = await admin.from("uploads").select("*").eq("id", uploadId).single();
    if (error || !upload) throw new Error(`upload ${uploadId} not found`);
    if (!upload.file_path) throw new Error("upload has no file_path");

    await admin.from("uploads").update({ status: "processing" }).eq("id", uploadId);

    const { data: file, error: dlErr } = await admin.storage.from("uploads").download(upload.file_path);
    if (dlErr || !file) throw new Error(`download failed: ${dlErr?.message ?? "no file"}`);

    const { rows, skipped } = parseWorkbook(new Uint8Array(await file.arrayBuffer()));
    await admin.from("uploads").update({ total_rows: rows.length, skipped_count: skipped.length }).eq("id", uploadId);

    const labs = new Map<string, number>();
    const products = new Map<string, number>();
    const doctors = new Map<string, number>();
    const patients = new Map<string, number>();
    let inserted = 0, updated = 0, newLabs = 0, newDoctors = 0, processed = 0;

    const resolveLab = async (name: string): Promise<number> => {
      if (labs.has(name)) return labs.get(name)!;
      const { data: ex } = await admin.from("labs").select("id").eq("name", name).maybeSingle();
      if (ex) { labs.set(name, ex.id); return ex.id; }
      const { data: ins, error } = await admin.from("labs").insert({ name }).select("id").single();
      if (error) throw error;
      newLabs++; labs.set(name, ins.id); return ins.id;
    };

    const resolveProduct = async (name: string, category: string): Promise<number> => {
      if (products.has(name)) return products.get(name)!;
      const { data: ex } = await admin.from("products").select("id").eq("name", name).maybeSingle();
      if (ex) { products.set(name, ex.id); return ex.id; }
      const { data: ins, error } = await admin.from("products").insert({ name, category }).select("id").single();
      if (error) throw error;
      products.set(name, ins.id); return ins.id;
    };

    const resolveDoctor = async (raw: string, name: string, route: string | null, labId: number): Promise<number> => {
      if (doctors.has(raw)) return doctors.get(raw)!;
      const { data: ex } = await admin.from("doctors").select("id").eq("raw", raw).maybeSingle();
      if (ex) { doctors.set(raw, ex.id); return ex.id; }
      const { data: ins, error } = await admin.from("doctors").insert({ raw, name, route, lab_id: labId }).select("id").single();
      if (error) throw error;
      newDoctors++; doctors.set(raw, ins.id); return ins.id;
    };

    const resolvePatient = async (name: string, externalId: string | null, labId: number): Promise<number> => {
      const key = `${name}|${externalId ?? ""}|${labId}`;
      if (patients.has(key)) return patients.get(key)!;
      let q = admin.from("patients").select("id").eq("name", name).eq("lab_id", labId);
      q = externalId === null ? q.is("external_id", null) : q.eq("external_id", externalId);
      const { data: ex } = await q.maybeSingle();
      if (ex) { patients.set(key, ex.id); return ex.id; }
      const { data: ins, error } = await admin.from("patients").insert({ name, external_id: externalId, lab_id: labId }).select("id").single();
      if (error) throw error;
      patients.set(key, ins.id); return ins.id;
    };

    for (const row of rows) {
      const labId = await resolveLab(row.lab);
      const productId = await resolveProduct(row.productName, row.category);
      const doctorId = await resolveDoctor(row.doctorRaw, row.doctorName, row.route, labId);
      const patientId = await resolvePatient(row.patientName, row.externalId, labId);
      const dedupeKey = `${row.pan}|${row.orderDate}|${patientId}|${productId}`;

      const { data: existing } = await admin.from("incoming_cases").select("id").eq("dedupe_key", dedupeKey).maybeSingle();

      const { error: upErr } = await admin.from("incoming_cases").upsert(
        {
          pan: row.pan,
          patient_id: patientId,
          lab_id: labId,
          doctor_id: doctorId,
          product_id: productId,
          order_date: row.orderDate,
          status: row.status,
          amount: row.amount,
          is_multi_unit: row.isMultiUnit,
          source_file: upload.file_name,
          upload_id: uploadId,
          dedupe_key: dedupeKey,
        },
        { onConflict: "dedupe_key" },
      );
      if (upErr) throw upErr;

      existing ? updated++ : inserted++;
      processed++;

      if (processed % PROGRESS_EVERY === 0) {
        await admin.from("uploads").update({
          processed_rows: processed,
          inserted_count: inserted,
          updated_count: updated,
          new_labs_count: newLabs,
          new_doctors_count: newDoctors,
        }).eq("id", uploadId);
      }
    }

    await admin.from("uploads").update({
      status: "completed",
      processed_rows: processed,
      inserted_count: inserted,
      updated_count: updated,
      new_labs_count: newLabs,
      new_doctors_count: newDoctors,
    }).eq("id", uploadId);
  } catch (e) {
    await admin.from("uploads").update({
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    }).eq("id", uploadId);
  }
}
```

- [ ] **Step 3: Type-check the function locally**

Run: `deno check supabase/functions/process-upload/index.ts`
Expected: no type errors. (If `EdgeRuntime` is flagged, it is a Supabase global available at runtime; add `// deno-lint-ignore no-explicit-any` only if necessary, or a `declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };` at the top.)

- [ ] **Step 4: Serve locally and smoke-test (manual)**

Run (in one terminal): `supabase functions serve process-upload --no-verify-jwt`
Then insert a fake `uploads` row + upload a file via the dialog in Task 5/6, or invoke with a known uploadId via `curl`:
`curl -i -X POST http://127.0.0.1:54321/functions/v1/process-upload -H "content-type: application/json" -d '{"uploadId":"<uuid>"}'`
Expected: `202 Accepted`; the `uploads` row transitions `processing → completed` with populated counts. (Full e2e is Task 7.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-upload/index.ts supabase/config.toml
git commit -m "feat(ingest): process-upload edge function (parse, normalize, upsert, progress)"
```

---

## Task 4: Upload-history read path (Supabase)

**Files:**
- Modify: `lib/data.ts` (replace `Upload` type + `getUploads`; remove the `uploads` JSON import)
- Modify: `components/upload-columns.tsx`
- Modify: `app/(dashboard)/upload/page.tsx`

- [ ] **Step 1: Replace the `Upload` type + `getUploads` in `lib/data.ts`**

Remove `import uploads from "../data/uploads.json";` and the existing `Upload` type + `getUploads` block. Add:

```ts
import { createClient } from "@/lib/supabase/server";

export type UploadStatus = "pending" | "processing" | "completed" | "failed";

export type Upload = {
  id: string;
  fileName: string;
  status: UploadStatus;
  uploadedAt: string;
  uploader: string;
  totalRows: number | null;
  processedRows: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  newLabsCount: number;
  newDoctorsCount: number;
  error: string | null;
};

export async function getUploads(): Promise<Upload[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("uploads")
    .select(
      "id, file_name, status, uploaded_at, total_rows, processed_rows, inserted_count, updated_count, skipped_count, new_labs_count, new_doctors_count, error, profiles(email)",
    )
    .order("uploaded_at", { ascending: false });

  if (error || !data) return [];

  return data.map((u) => ({
    id: u.id,
    fileName: u.file_name,
    status: u.status as UploadStatus,
    uploadedAt: u.uploaded_at,
    uploader: (u.profiles as { email: string } | null)?.email ?? "—",
    totalRows: u.total_rows,
    processedRows: u.processed_rows,
    insertedCount: u.inserted_count,
    updatedCount: u.updated_count,
    skippedCount: u.skipped_count,
    newLabsCount: u.new_labs_count,
    newDoctorsCount: u.new_doctors_count,
    error: u.error,
  }));
}
```

(Leave every analytics function and the other JSON imports in `lib/data.ts` unchanged.)

- [ ] **Step 2: Update `components/upload-columns.tsx`**

Add the `"pending"` status to the maps and a rows-progress column:

```tsx
const statusVariant: Record<Upload["status"], "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  processing: "secondary",
  completed: "default",
  failed: "destructive",
}

const statusLabel: Record<Upload["status"], string> = {
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
}
```

Add a column after `status` (before `uploadedAt`):

```tsx
  {
    id: "rows",
    header: "Rows",
    cell: ({ row }) => {
      const u = row.original
      if (u.status === "failed") {
        return <span className="text-xs text-destructive">{u.error ?? "Failed"}</span>
      }
      const total = u.totalRows ?? 0
      return (
        <span className="text-xs text-muted-foreground">
          {u.processedRows}/{total} · +{u.insertedCount} new
          {u.skippedCount > 0 ? ` · ${u.skippedCount} skipped` : ""}
        </span>
      )
    },
  },
```

- [ ] **Step 3: Make the upload page async**

In `app/(dashboard)/upload/page.tsx`:

```tsx
export default async function UploadPage() {
  const uploads = await getUploads()
  // ...rest unchanged
}
```

- [ ] **Step 4: Verify build/typecheck/lint**

Run: `yarn typecheck && yarn lint`
Expected: passes. Confirm there are no remaining imports of `data/uploads.json`.

- [ ] **Step 5: Commit**

```bash
git add lib/data.ts components/upload-columns.tsx "app/(dashboard)/upload/page.tsx"
git commit -m "feat(upload): read upload history from Supabase uploads table"
```

---

## Task 5: Upload dialog wiring + live progress

**Files:**
- Modify: `components/upload-dialog.tsx`
- Add shadcn primitive: `progress`

- [ ] **Step 1: Add the Progress primitive**

Run: `npx shadcn@latest add progress`
Expected: creates `components/ui/progress.tsx`.

- [ ] **Step 2: Rewrite `upload-dialog.tsx` for single `.xlsx` + real ingest**

Key changes:
- `const ACCEPTED = ".xlsx"`; drop `.xls,.csv`. Remove `multiple` from the input. `addFiles` keeps only the first `.xlsx` (`/\.xlsx$/i`).
- Add `import { createClient } from "@/lib/supabase/client"`, `import { useRouter } from "next/navigation"`, `import { Progress } from "@/components/ui/progress"`.
- Add state: `const [uploading, setUploading] = useState(false)` and `const [progress, setProgress] = useState<{ status: string; processed: number; total: number; inserted: number; skipped: number; error: string | null } | null>(null)`.

Replace `handleUpload` with:

```tsx
async function handleUpload() {
  const file = files[0]
  if (!file) return
  setUploading(true)
  setProgress({ status: "pending", processed: 0, total: 0, inserted: 0, skipped: 0, error: null })

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const id = crypto.randomUUID()
  const path = `${id}/${file.name}`

  const { error: insErr } = await supabase
    .from("uploads")
    .insert({ id, file_name: file.name, file_path: path, status: "pending", uploaded_by: user?.id })
  if (insErr) {
    setProgress((p) => ({ ...p!, status: "failed", error: insErr.message }))
    setUploading(false)
    return
  }

  // subscribe BEFORE invoking so no update is missed
  const channel = supabase
    .channel(`upload-${id}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "uploads", filter: `id=eq.${id}` },
      (payload) => {
        const n = payload.new as Record<string, number | string | null>
        setProgress({
          status: String(n.status),
          processed: Number(n.processed_rows ?? 0),
          total: Number(n.total_rows ?? 0),
          inserted: Number(n.inserted_count ?? 0),
          skipped: Number(n.skipped_count ?? 0),
          error: (n.error as string) ?? null,
        })
        if (n.status === "completed" || n.status === "failed") {
          supabase.removeChannel(channel)
          setUploading(false)
          router.refresh()
        }
      },
    )
    .subscribe()

  const { error: upErr } = await supabase.storage.from("uploads").upload(path, file, { upsert: true })
  if (upErr) {
    await supabase.from("uploads").update({ status: "failed", error: upErr.message }).eq("id", id)
    supabase.removeChannel(channel)
    setProgress((p) => ({ ...p!, status: "failed", error: upErr.message }))
    setUploading(false)
    return
  }

  const { error: fnErr } = await supabase.functions.invoke("process-upload", { body: { uploadId: id } })
  if (fnErr) {
    await supabase.from("uploads").update({ status: "failed", error: fnErr.message }).eq("id", id)
  }
}
```

- Add `const router = useRouter()` in the component.
- Render a progress block when `progress` is set (above `DialogFooter`):

```tsx
{progress && (
  <div className="flex flex-col gap-2 rounded-md border bg-muted/50 p-3">
    <div className="flex items-center justify-between text-xs">
      <span className="font-medium capitalize">{progress.status}</span>
      <span className="text-muted-foreground">
        {progress.processed}/{progress.total || "?"} rows
      </span>
    </div>
    <Progress value={progress.total ? (progress.processed / progress.total) * 100 : 0} />
    {progress.status === "failed" && (
      <p className="text-xs text-destructive">{progress.error}</p>
    )}
    {progress.status === "completed" && (
      <p className="text-xs text-muted-foreground">
        +{progress.inserted} new
        {progress.skipped > 0 ? ` · ${progress.skipped} skipped` : ""}
      </p>
    )}
  </div>
)}
```

- Disable the upload button while `uploading` and switch its label to "Uploading…". On `completed`, reset the file list (keep the dialog open so the user sees the result, or close after a short delay — keep open).

- [ ] **Step 3: Verify typecheck/lint**

Run: `yarn typecheck && yarn lint`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add components/upload-dialog.tsx components/ui/progress.tsx
git commit -m "feat(upload): wire dialog to storage + edge function with live realtime progress"
```

---

## Task 6: End-to-end verification

**Files:** none (verification only). Use the `verify` skill if available.

- [ ] **Step 1: Start the stack**

Run: `supabase start` (if not running), `supabase functions serve process-upload` (separate terminal), `yarn dev`.
Ensure you have an **admin** profile to log in with (per `requireAdmin`); create one via Supabase Studio (`profiles.role = 'admin'`) if needed.

- [ ] **Step 2: Upload the real sample workbook**

Log in, go to **Upload**, select `INCOMING CASE IN MAY 11 - 17. 2026 (1).xlsx`, click Upload.
Expected: progress bar advances live (pending → processing → completed); final shows `+N new` with the detail sheet's row count (~785 ingested, a few skipped). The upload-history table shows a `Completed` row with the uploader email.

- [ ] **Step 3: Verify stored data**

In Supabase Studio (or `psql`): confirm `incoming_cases` row count ≈ parsed rows, and `labs`/`doctors`/`patients`/`products` populated.

- [ ] **Step 4: Verify idempotency**

Upload the **same file again**.
Expected: completes with `updated` ≈ all rows and `inserted` ≈ 0; `incoming_cases` count unchanged (no duplicates). Confirm via a count query before/after.

- [ ] **Step 5: Verify failure path**

Upload a non-conforming `.xlsx` (e.g. a workbook without the detail sheet).
Expected: the row ends `failed` with an error message ("no detail sheet found"); UI shows the error; no partial garbage in `incoming_cases`.

- [ ] **Step 6: Final checks + commit (if any fixes)**

Run: `yarn typecheck && yarn lint && yarn build`
Expected: all pass. Commit any fixes discovered during verification.

---

## Notes / Risks

- **SheetJS in Deno** is imported from the official CDN ESM (`https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs`); the npm `xlsx` package is deprecated on the npm registry. `deno test`/`deno check` require network access (`--allow-net`) to fetch it the first time.
- **`EdgeRuntime.waitUntil`** keeps the background task alive after the 202 response; if it is unavailable in a given local runtime, fall back to `await ingest(...)` before responding (slower, but the client still gets progress via Realtime).
- **Realtime delivery** depends on the admin SELECT policy on `uploads` plus the table being in `supabase_realtime` (both in Task 1). If updates don't arrive, verify the channel filter and that the logged-in user is an admin.
- **Per-row queries**: ingestion does a few queries per row (resolve + existence check + upsert). For the ~785-row sample this is fine; if files grow to tens of thousands, batch the existence checks and entity resolution. Not needed now (YAGNI).
- **Out of scope (follow-up):** migrating dashboard analytics (`getSummary`/`getTimeSeries`/heatmap/etc.) off JSON to Supabase, and the users page off `users.json`.
