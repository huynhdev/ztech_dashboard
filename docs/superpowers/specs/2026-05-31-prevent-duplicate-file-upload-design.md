# Prevent Duplicate File Upload — Design

## Problem

The upload dialog lets admins upload `.xlsx` workbooks, which an edge function
ingests into `incoming_cases`. Nothing prevents re-uploading a workbook that has
already been ingested. The existing row-level `dedupe_key` upsert in
`process-upload` keeps duplicate *case rows* out of the data, but it still wastes
a full re-parse + re-ingest and clutters the upload history with redundant runs.

We want to stop a file that has already been successfully uploaded from being
uploaded again — detected and surfaced in the dialog before the user commits.

## Decisions

These were settled during brainstorming and drive the design:

- **Dedupe key:** SHA-256 hash of the file bytes (content hash). A renamed but
  byte-identical workbook is a duplicate; an edited/re-exported file with the
  same data is *not* (different bytes) and is allowed through.
- **Scope:** Global. A file is a duplicate if **any** user previously uploaded
  it — duplicates waste the shared dataset regardless of who uploaded them.
- **Enforcement:** Hard block, but **only against uploads that COMPLETED**.
  Re-uploading a file whose prior attempt **failed or is still pending** is
  allowed, so users can retry a file that errored.
- **When/where:** Check at **add time** (when a file is dropped/selected), not
  at upload time. The duplicate is surfaced in the file list before the user
  clicks Upload; duplicates are excluded from the upload run.
- **No DB unique constraint** (explicitly declined). The check is a client-side
  query against the `uploads` table. See "Known tradeoff" below.

## Architecture

Four touch points, smallest-to-largest:

### 1. Migration — add a hash column + partial index

```sql
alter table public.uploads add column file_hash text;

-- Partial index: we only ever query completed uploads, so index only those.
create index uploads_file_hash_completed_idx
  on public.uploads (file_hash) where status = 'completed';
```

No new RLS policy is required. The existing `"uploads admin read"` policy
(`for select to authenticated using ( public.is_admin() )`) already lets an
admin read every row, so the global duplicate check works from the browser
client. Only admins can reach the upload UI (storage bucket is admin-only).

After writing the migration: `yarn db:migrate` then `yarn db:gen-types` to
regenerate `types/database.ts` so `file_hash` is typed.

### 2. Hashing util — `lib/hash.ts`

Client-only helper, zero dependencies, using the Web Crypto API:

```ts
export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
```

Web Crypto has no streaming digest, so the whole file is read into an
`ArrayBuffer`. `.xlsx` workbooks here are small (KB–low MB), so this is fine.
MD5 is deliberately not used — the browser's `crypto.subtle` does not support
it, and a content fingerprint does not need to be MD5.

### 3. Duplicate check query

Given a hash, the dialog queries:

```ts
supabase
  .from("uploads")
  .select("id, file_name, uploaded_at, profiles(email)")
  .eq("file_hash", hash)
  .eq("status", "completed")
  .limit(1)
  .maybeSingle()
```

A returned row means the file is a duplicate; the embedded `profiles(email)` and
`uploaded_at` populate the "Already uploaded by X on date" message.

### 4. Dialog changes — `components/upload-dialog.tsx`

The dialog currently tracks `files: File[]`. It gains a per-file check status so
the file list can show duplicate state before upload.

- **Per-file state.** Track a record keyed by `file.name + file.size`:
  `{ status: "checking" | "ok" | "duplicate"; hash?: string; dupInfo?: { email: string; uploadedAt: string } }`.
- **On add** (`addFiles`): for each newly added file, set `checking`, compute
  `sha256Hex`, run the duplicate query, then set `ok` (storing the hash for
  reuse) or `duplicate` (storing `dupInfo`).
- **File list rendering:** a `checking` row shows a small spinner; a `duplicate`
  row shows a muted/destructive line *"Already uploaded · {email} · {date}"* and
  is visually distinguished. Duplicate (and still-`checking`) files are excluded
  from the Upload button's count.
- **On upload** (`handleUpload`): iterate only `ok` files. Reuse the
  already-computed `hash` — include it in the `uploads` insert
  (`.insert({ id, file_name, file_path, status, uploaded_by, file_hash: hash })`).
  Note the key mismatch to thread carefully: the add-time check state is keyed by
  `file.name + file.size` (matching the existing `addFiles` dedupe), while the
  `progress` map in `handleUpload`/`processFile` is keyed by the freshly generated
  `id`. `processFile` must look up the precomputed hash from the check state by
  `name + size` rather than recomputing it.
- **Typing the embed:** `profiles(email)` types as an array for a to-one embed
  under supabase-js. Reuse the existing
  `as unknown as Pick<Tables<"profiles">, "email"> | null` bridge already used in
  `lib/uploads.ts:47` — do not reach for `any`.
- **Type gating:** keep hashing + the check inside the existing
  `accept=".xlsx"` / `/\.xlsx$/i` filter path so non-xlsx drops never trigger a
  hash or query.
- **Belt-and-suspenders re-check:** inside `processFile`, immediately before the
  insert, run the duplicate query once more (cheap). This guards the narrow
  window where a file completed *between* add-time and clicking Upload. On a hit,
  mark the file `failed` with error "Already uploaded", `settleOnce`, and skip
  the storage upload + function invoke.

### 5. Edge function — no change

`process-upload` does not touch `file_hash`; the client sets it on insert.
Because the duplicate query filters `status = 'completed'`, the `file_hash` left
on a failed or pending row is ignored — so **retrying a previously-failed file
just works** with no cleanup.

## Data flow (add → upload)

```
User drops/selects file
  → addFiles: status=checking
  → sha256Hex(file)
  → query uploads WHERE file_hash=h AND status='completed'
       ├─ hit  → status=duplicate, show "Already uploaded by X on date" (excluded)
       └─ none → status=ok, store hash
User clicks Upload (only ok files)
  → processFile: re-check duplicate (guard window)
       ├─ hit  → mark failed "Already uploaded", skip
       └─ none → INSERT uploads {..., file_hash} → upload to storage → invoke fn
  → (unchanged) edge function ingests, Realtime streams progress
```

## Edge cases

- **Renamed identical file:** blocked (hash matches).
- **Edited / re-exported file (same data, different bytes):** allowed; the
  existing row-level `dedupe_key` upsert still prevents duplicate *case* rows.
- **Previously-failed or pending file:** allowed to retry (filter is
  `completed` only).
- **File completes between add and click:** caught by the `processFile`
  re-check.
- **Hashing/check error at add time:** treat as `ok` (fail open) so a transient
  Realtime/network hiccup never blocks a legitimate upload; the `processFile`
  re-check still provides a second chance to catch a true duplicate.

## Known tradeoff

With no DB unique constraint, two admins uploading the **same** file at the
**exact same moment** can both pass the check and both complete, producing two
`uploads` audit rows. The row-level `dedupe_key` upsert means the actual case
data is **not** duplicated — only the audit history shows two runs. This is
accepted (the unique-constraint option was declined) and documented here so it
is a known limitation, not a surprise.

## Testing

- **`lib/hash.ts`:** unit test `sha256Hex` against a known vector (e.g. the
  SHA-256 of a small fixed byte string) to confirm hex formatting and
  correctness.
- **Dialog (manual / component):**
  - Add a brand-new file → shows `ok`, uploads normally, row gets `file_hash`.
  - Re-add the same file (after a completed upload) → shows `duplicate` with the
    correct uploader/date, excluded from the Upload count.
  - Re-add a file whose prior upload **failed** → allowed (`ok`).
  - Rename a completed file and add it → `duplicate` (hash match).
- **Migration:** `yarn db:reset` applies cleanly; `yarn db:gen-types` produces a
  `file_hash` field; `yarn typecheck` passes.
```
