# Design: `.xlsx` Upload → Supabase Ingestion

**Date:** 2026-05-31
**Status:** Approved (pending spec review)
**Feature:** Upload an incoming-cases `.xlsx` workbook, parse it, and ingest normalized
data into Supabase with live processing feedback.

## 1. Problem & Context

The dashboard visualizes dental-lab incoming cases (revenue, volume, category
breakdowns, top labs/doctors, client heatmap). Today all of this data is read from
local JSON files in `data/` via synchronous functions in `lib/data.ts`. The project
rule (`.claude/rules/supabase.md`) requires all app data to flow through Supabase and
forbids local JSON as a data source.

There is no domain schema in Supabase yet — only `keepalive` and `profiles` (auth).
Admin auth is fully wired: `requireAdmin()` gates the entire `app/(dashboard)/` route
group, so only admins reach the upload UI.

The real source file is a multi-sheet `.xlsx` workbook (sample:
`INCOMING CASE IN MAY 11 - 17. 2026 (1).xlsx`). Only one sheet matters for ingestion —
the **detail sheet** with one row per case. The other two sheets (`Sheet1`, `SUMMARY`)
are pivot tables derived from it.

### Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Data target | Build Supabase schema + ingest; switch dashboard reads to Supabase |
| Accepted format | `.xlsx` only |
| Initial seed | Start empty (no JSON seed) |
| Re-upload behavior | Idempotent upsert on a natural dedupe key |
| Upload UX | One-shot ingest with **live (real-time) processing feedback** |
| Ingestion architecture | **Approach B**: Storage + Edge Function + Realtime |
| Privileged writes | Edge Function uses platform-injected `SUPABASE_SERVICE_ROLE_KEY` (no secret added to `.env.local`) |
| Auth / attribution | Login already implemented; attribute uploads to the logged-in admin |

## 2. Goals / Non-Goals

**Goals**
- An admin can upload a `.xlsx` incoming-cases workbook from the existing upload dialog.
- The file is parsed server-side, normalized into labs/doctors/patients/products, and
  ingested as `incoming_cases`, idempotently.
- The user sees genuine real-time progress (rows processed / total, new entities,
  inserted vs updated) and a final success/failure state.
- The dashboard analytics read from Supabase and reflect uploaded data.

**Non-Goals**
- Migrating the **users page** (`app/(dashboard)/users/page.tsx`) off `users.json` —
  unrelated to ingestion; separate follow-up.
- Pushing analytics aggregation into SQL views / RPC — aggregations stay in TypeScript.
- CSV or `.xls` support — `.xlsx` only.
- A pre-commit preview/confirm step — ingestion is one-shot.
- Editing/deleting already-ingested cases through the UI.

## 3. Architecture (Approach B)

```
upload-dialog (client, admin)
  1. INSERT uploads row {status:'pending', file_name, uploaded_by}   -> uploadId
  2. Storage.upload  uploads/{uploadId}/{filename}.xlsx              (private bucket)
  3. supabase.functions.invoke('process-upload', { uploadId })
  4. subscribe Realtime on uploads row (id = uploadId)              -> live progress

process-upload Edge Function (Deno, service-role, EdgeRuntime.waitUntil)
  - returns 202 immediately, processes in the background:
  a. UPDATE uploads status='processing'
  b. download file from Storage, parse with npm:xlsx
  c. auto-detect DETAIL sheet (header row contains Pan/Patient/Lab/Doctor/Order date/
     Product/Status/Amount)
  d. per batch: resolve/upsert lab, doctor, patient, product -> upsert case
  e. UPDATE uploads {processed_rows, total_rows, inserted_count, updated_count,
     skipped_count} per batch  -> Realtime pushes to client
  f. UPDATE uploads status='completed' | 'failed' (+ error message)
```

The dialog is the Realtime consumer; the progress bar and counters are driven entirely
by updates to the single `uploads` row. The function returning early via
`EdgeRuntime.waitUntil` avoids holding a long invoke connection open.

### Why Approach B over a streaming route handler

- Decoupled and idiomatic for Supabase; ingestion is retryable/auditable from the
  stored file.
- Survives a client reload (progress lives in the `uploads` row, not the connection).
- Keeps xlsx parsing (and the SheetJS dependency) entirely inside the Deno function —
  no new dependency in the Next.js app.
- Realtime + Storage + edge runtime are already enabled in `supabase/config.toml`.

## 4. Database Schema

One migration: `supabase/migrations/20260531020000_create_incoming_cases.sql`
(timestamp must be greater than every existing migration). All SQL lowercase, RLS
enabled on every table, granular policies (separate select/insert/update/delete), roles
specified with `to`, `(select auth.uid())` wrapped. Mirrors the `profiles` migration and
follows the updated grant rule (GRANT Data-API privileges + RLS + policies as a unit;
grant `usage, select` on sequences).

| Table | Key columns | Resolve / unique key |
|---|---|---|
| `labs` | `id bigint generated always as identity`, `name text not null` | unique `name` |
| `products` | `id`, `name text not null`, `category text` | unique `name` |
| `doctors` | `id`, `name text not null`, `route text`, `raw text not null`, `lab_id bigint references labs` | unique `raw` |
| `patients` | `id`, `name text not null`, `external_id text`, `lab_id bigint references labs` | unique `(name, external_id, lab_id)` |
| `incoming_cases` | `id`, `pan text`, `patient_id references patients`, `lab_id references labs`, `doctor_id references doctors`, `product_id references products`, `order_date date not null`, `status text`, `amount numeric not null default 0`, `is_multi_unit boolean not null default false`, `source_file text`, `upload_id uuid references uploads`, `dedupe_key text not null` | **unique `dedupe_key`** |
| `uploads` | `id uuid default gen_random_uuid()`, `file_name text not null`, `file_path text`, `status text not null default 'pending'`, `total_rows int`, `processed_rows int not null default 0`, `inserted_count int not null default 0`, `updated_count int not null default 0`, `skipped_count int not null default 0`, `error text`, `uploaded_by uuid references profiles`, `uploaded_at timestamptz not null default now()` | — |

**dedupe_key** = `pan | order_date | patient_id | product_id` (computed in the function
after entity resolution). `incoming_cases` upsert is `on conflict (dedupe_key) do update`,
making re-uploads and overlapping date ranges idempotent.

**Status values** for `uploads`: `pending`, `processing`, `completed`, `failed`. Modeled
as a `text` column with a `check` constraint (or an enum — implementation choice; enum
preferred for parity with `user_role`).

**New-entity counters**: the UI shows "new labs / new doctors". To back this, `uploads`
gains `new_labs_count int not null default 0` and `new_doctors_count int not null default 0`,
updated by the function as it creates entities. (If a counter is dropped from the UI, drop
the matching column — they must stay reconciled.)

**Explicit grants (required — RLS alone is insufficient).** Per `.claude/rules/supabase.md`,
new `public` tables are not auto-exposed to the Data API. Each table above gets, as a unit:
`grant select, insert, update, delete on public.<table> to authenticated;`
`grant select, insert, update, delete on public.<table> to service_role;`
then `alter table ... enable row level security;` then the policies. Because the PKs are
`bigint generated always as identity`, also
`grant usage, select on all sequences in schema public to authenticated, service_role;`
(or per-sequence). Scope `authenticated` grants down to `select` only if a table proves
read-only from the client — but ingestion writes go through the service-role function, so
`authenticated` realistically needs only `select`; keep `service_role` full.

**Storage**: a private bucket `uploads` created in the migration (insert into
`storage.buckets`) with storage RLS policies allowing admins to insert/read objects.

**Realtime**: add `public.uploads` to the `supabase_realtime` publication so the client
can subscribe to row updates.

**Indexes**: `incoming_cases(order_date)`, `incoming_cases(lab_id)`,
`incoming_cases(product_id)`, `incoming_cases(upload_id)`, plus the unique constraints
above; `uploads(uploaded_at)`.

After writing the migration: `yarn db:migrate` then `yarn db:gen-types` to regenerate
`types/database.ts`.

## 5. RLS Policy Summary

For each domain table (`labs`, `products`, `doctors`, `patients`, `incoming_cases`) and
`uploads`:
- SELECT — `to authenticated using (public.is_admin())`.
- INSERT/UPDATE/DELETE — `to authenticated` gated by `public.is_admin()`.

The Edge Function writes with the service-role key and bypasses RLS, so heavy ingestion
writes are not subject to these policies; the policies exist for any direct client
access and to satisfy the always-on-RLS rule. Storage policies similarly restrict the
`uploads` bucket to admins.

## 6. Parsing Rules (Edge Function)

Re-derives the transform that originally produced `data/incoming_cases_raw.json`.

- **Detail sheet detection**: iterate worksheets; pick the one whose header row contains
  `Pan`, `Patient`, `Lab`, `Doctor`, `Order date`, `Product`, `Status`, `Amount`. Header
  is not the first row (there is a title row), so scan for it. Ignore pivot sheets.
- **Patient**: `"THUY DOAN #3653"` -> name `THUY DOAN`, `external_id` `3653`. Suffix
  optional (no `#` -> `external_id = null`).
- **Doctor**: `"Le, Tommy DDS - RTE: A"` -> `name` `Le, Tommy DDS`, `route` `A`; store the
  full original string as `raw`. Missing route -> `route = null`.
- **Product**: `category` = substring before the first `" - "` (e.g. `Zirconia`,
  `Implant`); products without a delimiter use the whole name as category.
  `is_multi_unit` = product cell ends with `...`.
- **Order date**: SheetJS date cell -> `YYYY-MM-DD`.
- **Amount**: numeric; `0` allowed and preserved.
- **Status**: stored verbatim (`Shipped`, `In Production`, `Hold`, etc.).
- **Lab**: resolved/created by name; `doctors.lab_id` / `patients.lab_id` linked to it.
- **Skipped rows**: rows missing Pan, Patient, or Lab are counted toward
  `skipped_count` (not fatal); ingestion continues.

## 7. Read-Path Migration (`lib/data.ts`)

Keep all existing in-memory aggregation logic; replace JSON imports with async Supabase
fetches of base tables via the server client (`@/lib/supabase/server`), then run the
same transforms.

- `getSummary`, `getTimeSeries`, `getCategoryBreakdown`, `getTopLabs`, `getTopDoctors`,
  `getClientHeatmap` become `async`; they fetch `incoming_cases` (+ `labs`/`products`/
  `doctors` as needed) and aggregate in TypeScript.
- `export const clientChanges = getClientChanges(20)` (computed at import time) becomes an
  async function `getClientChanges(20)`; `components/client-change-table.tsx` updated to
  receive it as data.
- `app/(dashboard)/page.tsx` (server component) `await`s the data functions and passes
  results to the client chart components (unchanged props).
- `getUploads()` reads the `uploads` table; the `Upload` type gains `status`/progress/
  counts and resolves `uploaded_by` -> profile email. Note `id` becomes a UUID string and
  the `status` union gains `"pending"` (currently `"completed" | "processing" | "failed"`).
- The dataset is small (hundreds–few thousand rows/week), so fetch-then-aggregate is
  acceptable; no SQL views/RPC.
- **`getClientChanges` semantics shift**: it currently splits a single week's file at the
  data's own date midpoint to derive new/churned labs. Once `incoming_cases` accumulates
  multiple weeks, that midpoint splits the whole accumulated dataset, not one file. The
  logic is kept as-is for now, but the planner should be aware the new-vs-churned meaning
  changes with multi-week data (revisit if it misleads).

Domain `data/*.json` files stop being a data source (the `users.json`-backed users page
is the only remaining JSON reader and is explicitly out of scope).

## 8. Client Changes

- `components/upload-dialog.tsx`: implement `handleUpload` — insert `uploads` row; upload
  to Storage; invoke `process-upload`; subscribe to Realtime on the row; render a live
  progress bar + counters (processed/total, inserted/updated/skipped, new labs/doctors);
  show success/failure end state; handle errors. This also **narrows existing behavior**:
  the dialog today accepts multiple files and `.xls`/`.csv` — change the `ACCEPTED`
  constant to `.xlsx`, remove the `multiple` attribute, simplify drag-drop to a single
  file, and update the dialog copy accordingly.
- `components/upload-columns.tsx` + upload page: status badge, progress, row counts,
  uploader email.

## 9. Edge Function

`supabase/functions/process-upload/index.ts` (Deno):
- `Deno.serve`; `npm:xlsx@<pinned-version>` for parsing; `npm:@supabase/supabase-js@2`
  with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (auto-injected).
- Returns `202` immediately; runs ingestion in `EdgeRuntime.waitUntil`.
- Reuses parsing rules from §6; resolves entities with batched upserts; updates the
  `uploads` row progress per batch; sets terminal status.
- Registered in `supabase/config.toml` (`[functions.process-upload]`, `verify_jwt = true`
  so only authenticated callers invoke it; admin check optional inside).
- File writes (if any) only under `/tmp`.

## 10. Testing

- **Unit**: parsing logic against the real sample workbook's 789-row detail sheet —
  verify total rows, entity extraction (route, external_id, category, multi-unit),
  amount/date formatting, and skip counting.
- **Idempotency**: ingest the same file twice -> second run reports `updated`, not
  duplicated; row counts stable.
- **Manual e2e**: `supabase functions serve` locally; upload via the dialog; watch live
  progress over Realtime; confirm the dashboard reflects the new data and the upload
  history row ends `completed`.

## 11. Risks & Open Questions

- **SheetJS in Deno**: confirm `npm:xlsx` parses the workbook in the edge runtime; date
  cell handling may need `cellDates: true`.
- **Realtime auth**: the client must have admin SELECT on `uploads` for the subscription
  to deliver row updates; verify the publication + RLS combination delivers updates.
- **Large files**: 50 MiB storage limit is configured; batch size for upserts should keep
  the function within edge memory/time limits (sample is ~789 rows — comfortable).
- **`gen_random_uuid()`** requires `pgcrypto`/`pgsql` availability (standard on Supabase).
