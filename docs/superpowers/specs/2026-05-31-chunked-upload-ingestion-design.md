# Chunked Upload Ingestion — Design

## Problem

The `process-upload` edge function ingests an `.xlsx` workbook into
`incoming_cases` in a single background task (`EdgeRuntime.waitUntil(ingest)`).
That task does a per-row `SELECT-then-INSERT` for labs/doctors/products/patients
plus a `SELECT` + upsert into `incoming_cases` — almost entirely sequential
async I/O. The whole thing runs inside one invocation, so it is bound by the
**edge function wall-clock limit**, not CPU:

| Limit | Free | Paid |
| --- | --- | --- |
| Wall-clock (worker active time, incl. background tasks) | **150s** | 400s |
| CPU time per request (excludes async I/O) | 2s | 2s |
| Memory | 256 MB | 256 MB |

At realistic DB round-trip latency the per-row loop exhausts the 150s window
after roughly a thousand rows, so large workbooks time out mid-ingest and the
`uploads` row is left stuck in `processing`. Separately, `parseWorkbook()`
(SheetJS `XLSX.read`) is pure CPU and a large workbook can approach the 2s CPU
limit on its own.

We want ingestion to scale to arbitrarily large workbooks by splitting the work
across multiple short edge-function invocations, each comfortably inside a fresh
150s window.

## Decisions

These were settled during brainstorming and drive the design:

- **Two steps.** `1_parsed_data` parses the xlsx once and persists the result;
  `2_upsert_data` ingests the persisted rows in bounded chunks. The `step` is
  passed in the invoke body.
- **Self-chaining, cursor-based, no `index` param.** The client invokes the
  function **once**. The function chains itself: each `2_upsert_data`
  invocation reads the cursor from `uploads.processed_rows`, processes one
  chunk, advances the cursor, and re-invokes itself for the next chunk until
  rows are exhausted. There is **no `index` argument** — the cursor is the only
  source of truth, so a stuck upload self-heals by re-invoking `2_upsert_data`.
- **Chunk size is env-configurable, default 200.**
  `const CHUNK_SIZE = Number(Deno.env.get("CHUNK_SIZE") ?? 200)`.
- **Sharded storage.** `1_parsed_data` splits parsed rows into one small file
  per chunk (`parsed-000.json`, `parsed-001.json`, …). `2_upsert_data`
  downloads **only its one shard**, picked by `processed_rows / CHUNK_SIZE`.
  This bounds memory to one chunk, transfers no redundant bytes, and needs no
  byte-offset index or streaming reader. (Alternatives — a single JSON array,
  or a single NDJSON file streamed with a byte cursor — were considered and
  declined: equal outcome, more code/complexity. See "Alternatives considered".)
- **No DB migration.** Every column needed already exists on `uploads`
  (`processed_rows` as the cursor, plus `total_rows`, `skipped_count`,
  `inserted_count`, `updated_count`, `new_labs_count`, `new_doctors_count`,
  `status`, `error`). The parse/upsert phase is distinguished by the `step`
  argument, not by a new status — the existing `upload_status` enum
  (`pending | processing | completed | failed`) is reused unchanged.

## Architecture

### Flow

```
Client (per file, still sequential — see "Client" below)
  └─ invoke process-upload { uploadId, step: "1_parsed_data" }   ── then just watches Realtime

process-upload  [1_parsed_data]                       ← one fresh 150s window
  ├─ load upload row; guard file_path
  ├─ status → processing   (total_rows stays null → UI shows "Parsing workbook…")
  ├─ download xlsx → parseWorkbook()
  ├─ rows.length === 0 → fail ("no detail sheet found" / "no parseable rows found")
  ├─ write shards: for each CHUNK_SIZE slice i → put uploads/${uploadId}/parsed-${i}.json
  ├─ uploads.update { total_rows: rows.length, skipped_count, processed_rows: 0 }
  └─ self-invoke { uploadId, step: "2_upsert_data" }

process-upload  [2_upsert_data]                       ← a fresh 150s window PER chunk
  ├─ load upload row → cursor = processed_rows, current counters, total_rows, file_name
  ├─ if status already completed/failed → no-op (stray-invoke guard)
  ├─ if cursor >= total_rows → status = completed; stop
  ├─ shard = cursor / CHUNK_SIZE
  ├─ download uploads/${uploadId}/parsed-${shard}.json → rows (≤ CHUNK_SIZE)
  ├─ resolve labs/doctors/products/patients + upsert incoming_cases   (today's logic, unchanged)
  ├─ uploads.update { processed_rows: cursor + rows.length,
  │                   inserted/updated/new_* counts (absolute totals) }
  └─ cursor + rows.length < total_rows  ?  self-invoke { step: "2_upsert_data" }  :  status = completed
```

The client invokes once; the function drives the chunk loop itself. Each chunk
gets its own 150s wall-clock budget, so total row count is no longer bounded by
a single invocation.

### 1. Function structure — `supabase/functions/process-upload/index.ts`

`Deno.serve` reads `{ uploadId, step }` from the body, returns `202`
immediately, and dispatches the work inside `EdgeRuntime.waitUntil`:

- `step === "2_upsert_data"` → `upsertStep(admin, uploadId)`
- otherwise (`"1_parsed_data"` or absent) → `parseStep(admin, uploadId)`

`getSecretKey()`, `errorMessage()`, and the admin-client construction are kept
as-is. The existing `ingest()` is split into `parseStep` and `upsertStep`.

`parseStep(admin, uploadId)`:

- load the upload row; throw if missing or no `file_path`.
- `uploads.update { status: "processing" }` (leave `total_rows` null so the
  client renders the parse phase).
- download the xlsx, `parseWorkbook(bytes)`.
- if `rows.length === 0` → throw the existing "no detail sheet found" /
  "no parseable rows found" reason (caught → `status = failed`).
- write shards: walk `rows` in `CHUNK_SIZE` slices; for slice `i`, upload
  `parsed-${pad(i)}.json` (the slice serialized as a JSON array) to the
  `uploads` bucket under `${uploadId}/`. Use `{ upsert: true }` so a re-run of
  `parseStep` overwrites cleanly.
- `uploads.update { total_rows: rows.length, skipped_count: skipped.length, processed_rows: 0 }`.
- self-invoke `{ uploadId, step: "2_upsert_data" }`.

`upsertStep(admin, uploadId)`:

- load the upload row → `cursor = processed_rows`, current counters
  (`inserted_count`, `updated_count`, `new_labs_count`, `new_doctors_count`),
  `total_rows`, `file_name`.
- if `status` is already `completed` or `failed` → return (stray-invoke guard).
- if `total_rows == null` → throw (`2_upsert_data` invoked before parse
  finished — should not happen via the normal chain).
- if `cursor >= total_rows` → `status = completed`; return.
- `shard = Math.floor(cursor / CHUNK_SIZE)`; download
  `parsed-${pad(shard)}.json`; `JSON.parse` → `rows: ParsedRow[]`.
- **seed counters from the DB row** (`let inserted = upload.inserted_count`,
  etc.) so totals accumulate across chunks, then run the existing per-row
  resolve + upsert body over this shard's rows.
- `uploads.update { processed_rows: cursor + rows.length, inserted_count,
  updated_count, new_labs_count, new_doctors_count }` (absolute totals).
- if `cursor + rows.length < total_rows` → self-invoke
  `{ uploadId, step: "2_upsert_data" }`; else `status = completed`.

The in-memory resolver `Map`s (labs/products/doctors/patients) are
per-invocation and rebuilt each chunk. Correctness is unaffected — the
`SELECT`-then-`INSERT` helpers still find rows created by earlier chunks — at
the cost of a few extra lookups per chunk (the first occurrence of each
lab/doctor/product in a shard re-`SELECT`s). Negligible.

**Self-invoke** uses the admin client:
`admin.functions.invoke("process-upload", { body: { uploadId, step: "2_upsert_data" } })`.
This awaits only the immediate `202` (the function returns before doing work),
so the current invocation ends cleanly and the next chunk runs in a fresh
worker with its own wall-clock window. Termination is the `cursor >= total_rows`
check — there is no other loop guard, so the cursor advancing every chunk is
what guarantees the chain ends.

### 2. Storage layout

All artifacts live in the existing `uploads` bucket under the upload's id,
alongside the source xlsx:

```
uploads/${uploadId}/${file_name}        ← source xlsx (written by client, today)
uploads/${uploadId}/parsed-000.json     ← rows   0 .. CHUNK_SIZE-1
uploads/${uploadId}/parsed-001.json     ← rows CHUNK_SIZE .. 2*CHUNK_SIZE-1
...
```

Each shard is a JSON array of `ParsedRow` (the existing `parse.ts` type). Shard
index is zero-padded to a fixed width so listings sort naturally; the function
addresses shards by computed name, not by listing. `skipped` rows are not
persisted — only `skipped.length` is needed and it is written to
`uploads.skipped_count` in `parseStep`.

### 3. Status & progress — no migration, client largely unchanged

The existing `upload_status` enum and the client's `deriveProgress` are reused
as-is:

- **parse phase** → `status = processing`, `total_rows = null` → existing client
  branch renders "Parsing workbook…".
- **upsert phase** → `total_rows` set, `processed_rows` climbing → "Ingesting
  X/Y rows".
- **terminal** → `completed` / `failed` exactly as today. The terminal
  `completed` event now arrives at the *end of the whole chain* (after the last
  chunk), which is the event the client already waits on.

### 4. Client — `components/upload-dialog.tsx`

One change: the single invoke gains the step argument.

```ts
await supabase.functions.invoke("process-upload", {
  body: { uploadId: id, step: "1_parsed_data" },
})
```

Everything else is unchanged. In particular:

- The **sequential-across-files** loop is still required and still correct. Two
  files ingesting concurrently would still race on the lab/doctor
  `SELECT-then-INSERT`, so files must still run one at a time. The client
  already waits for each file's terminal `completed`/`failed` Realtime UPDATE
  before starting the next — and that terminal event now simply arrives after
  the self-chain finishes. No change to `processFile`, `settleOnce`, the
  Realtime subscription, or the `SUBSCRIBED` guard.
- Progress rendering is unchanged (see §3).

## Error handling & recovery

Each step wraps its body in `try/catch`; on throw it writes
`uploads.update { status: "failed", error: errorMessage(e) }` and the chain
stops (no further self-invoke). `errorMessage` already unwraps `PostgrestError`
objects so a failed DB call records a human-readable reason rather than
`[object Object]`.

**Recovery is resume-capable by construction.** Re-invoking
`{ uploadId, step: "2_upsert_data" }` for a stuck/failed upload reads
`processed_rows` and continues from the next unprocessed shard. The shards are
still in storage, and the `incoming_cases` upsert is keyed on `dedupe_key`, so
re-processing a shard does not duplicate case rows.

**Known caveat — count drift on mid-chunk crash.** A chunk advances
`processed_rows` only *after* its shard's upserts complete. If an invocation
crashes partway through a shard (after some upserts, before the counter write),
a resume re-processes that whole shard from its start. The `dedupe_key` upsert
keeps the **case data correct** (no duplicate rows), but the displayed
`inserted_count` / `updated_count` can over-report by up to the rows that were
re-run. This is accepted rather than adding per-row cursor bookkeeping: the data
is right; only cosmetic counters drift, and only after a crash.

## Alternatives considered

- **Single JSON array, `.download()` per chunk.** Simplest, no sharding, but
  every chunk downloads and `JSON.parse`s the *entire* array to use one chunk of
  it → redundant CPU/bandwidth that grows with the file. Declined.
- **Single NDJSON, streamed with a byte cursor + HTTP `Range`.** Bounds memory
  and (with a persisted byte offset) achieves linear bandwidth, exploiting the
  fact that chunks run strictly sequentially. But it requires UTF-8-aware byte
  accounting, partial-line handling at range boundaries, and a new `byte_cursor`
  column — more code and more to get wrong for the same outcome as sharding.
  Declined.
- **Client-orchestrated chunk loop.** Client invokes each chunk and waits on
  Realtime between them. Simpler server code, but ingestion only progresses
  while the browser tab is open. Declined in favor of server self-chaining.
- **Streaming the xlsx instead of downloading it.** Not viable: an `.xlsx` is a
  ZIP whose central directory is at the end of the file, and SheetJS needs the
  complete buffer — there is no incremental row API. The xlsx is downloaded once
  in `parseStep` and never again, so there is no repeated-transfer problem to
  solve on the source file anyway.

## Testing

- **Pure helpers (unit, alongside `parse.test.ts`).** Extract and test the chunk
  math as pure functions:
  - sharding in `parseStep`: a row count + `CHUNK_SIZE` → the set of
    `(shardIndex, startRow, endRow)` slices (covers exact multiples and a final
    short shard).
  - cursor → shard mapping and the "more rows?" / "done" decision used by
    `upsertStep` (covers `cursor` on a shard boundary, the last shard, and
    `cursor >= total_rows`).
  - counter accumulation: seed-from-row + delta → absolute totals.
- **Manual / local Supabase.** Self-invoke chaining and storage round-trips are
  hard to assert in unit tests on the Deno edge runtime, so verify against local
  Supabase:
  - small workbook (< CHUNK_SIZE rows) → one parse + one upsert chunk →
    `completed` with correct counts.
  - workbook spanning several shards → `processed_rows` climbs per chunk, the
    chain self-terminates at `completed`, counts match a single-pass ingest.
  - empty/headerless workbook → `failed` in `parseStep`, no shards consumed.
  - re-invoke `2_upsert_data` on a `failed` mid-run upload → resumes from
    `processed_rows`, no duplicate `incoming_cases` rows.
- **`yarn typecheck` / `yarn lint`** pass; the parser test suite still passes.
```
