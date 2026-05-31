# Chunked Upload Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.xlsx` ingestion scale past the edge-function 150s wall-clock limit by splitting it into a one-time parse step that writes sharded JSON, and a self-chaining upsert step that ingests one shard per invocation.

**Architecture:** `process-upload` becomes two steps selected by a `step` body arg. `1_parsed_data` downloads the xlsx, parses it once, writes one small JSON shard per `CHUNK_SIZE` rows to storage, resets the cursor + counters, then self-invokes step 2. `2_upsert_data` reads the cursor (`uploads.processed_rows`), downloads exactly the one shard it needs (`cursor / CHUNK_SIZE`), upserts those rows, advances the cursor via a **guarded conditional UPDATE** (a lease that prevents double-chains), and self-invokes itself for the next chunk until the cursor reaches `total_rows`. The client invokes once and watches Realtime exactly as today. No DB migration.

**Tech Stack:** Supabase Edge Functions (Deno), `@supabase/supabase-js@2`, SheetJS (`xlsx`), Supabase Storage + Realtime, Next.js 16 / React 19 client. Tests: `deno test` for pure edge-function helpers.

**Spec:** `docs/superpowers/specs/2026-05-31-chunked-upload-ingestion-design.md`

---

## Testing note (read first)

This project has **no app-level JS test runner**. The only automated tests are Deno tests for edge-function code (`supabase/functions/process-upload/parse.test.ts`, run with `deno test`). This plan follows that pattern: the **pure chunk-math helpers** get real `deno test` unit tests (Task 1, TDD); the **stateful pieces** (self-invoke chaining, storage shards, the cursor lease, the resolve+upsert body) are verified end-to-end against **local Supabase** because they cannot be unit-tested on the Deno edge runtime. The client change is one line, verified via `yarn typecheck` + `yarn lint` + manual upload.

**The self-invoke transport is the single load-bearing assumption** (a function reaching `${SUPABASE_URL}/functions/v1/process-upload` from inside the edge runtime). Task 2 proves it end-to-end with a skeleton that chains but does no DB upserts, **before** Task 3 adds the ingest body. If Task 2's chain does not fire locally, stop and resolve the transport (see Task 2 troubleshooting) before continuing.

Local Supabase runs on port 54326 (see `CLAUDE.md`). Use `npx supabase@latest` for all CLI calls (the globally-installed `supabase` cannot parse this repo's `config.toml` — see memory).

---

## File Structure

- **Create:** `supabase/functions/process-upload/chunking.ts` — pure, I/O-free chunk math: shard filename, parse-time chunk ranges, cursor→shard mapping, completion/final-shard predicates. Single responsibility, fully unit-testable.
- **Create:** `supabase/functions/process-upload/chunking.test.ts` — Deno unit tests for `chunking.ts`.
- **Modify:** `supabase/functions/process-upload/index.ts` — split the existing `ingest()` into `parseStep()` + `upsertStep()`, route on `step`, add `selfInvokeUpsert()` and `markFailed()` helpers. Keeps `getSecretKey()` / `errorMessage()` / admin-client setup as-is.
- **Modify:** `components/upload-dialog.tsx:342-345` — add `step: "1_parsed_data"` to the single `functions.invoke` body. Nothing else changes.

---

## Task 1: Pure chunk-math helpers (`chunking.ts`)

**Files:**
- Create: `supabase/functions/process-upload/chunking.ts`
- Test: `supabase/functions/process-upload/chunking.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/process-upload/chunking.test.ts`:

```ts
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shardName,
  chunkRanges,
  shardIndexForCursor,
  isComplete,
  isFinalShard,
} from "./chunking.ts";

Deno.test("shardName zero-pads to a fixed width", () => {
  assertEquals(shardName(0), "parsed-00000.json");
  assertEquals(shardName(7), "parsed-00007.json");
  assertEquals(shardName(1234), "parsed-01234.json");
});

Deno.test("chunkRanges: exact multiple of chunkSize", () => {
  assertEquals(chunkRanges(400, 200), [
    { index: 0, start: 0, end: 200 },
    { index: 1, start: 200, end: 400 },
  ]);
});

Deno.test("chunkRanges: short final chunk", () => {
  assertEquals(chunkRanges(450, 200), [
    { index: 0, start: 0, end: 200 },
    { index: 1, start: 200, end: 400 },
    { index: 2, start: 400, end: 450 },
  ]);
});

Deno.test("chunkRanges: fewer rows than chunkSize → single chunk", () => {
  assertEquals(chunkRanges(5, 200), [{ index: 0, start: 0, end: 5 }]);
});

Deno.test("chunkRanges: zero rows → no chunks", () => {
  assertEquals(chunkRanges(0, 200), []);
});

Deno.test("chunkRanges: rejects non-positive chunkSize", () => {
  assertThrows(() => chunkRanges(10, 0));
});

Deno.test("shardIndexForCursor maps a cursor to its shard", () => {
  assertEquals(shardIndexForCursor(0, 200), 0);
  assertEquals(shardIndexForCursor(199, 200), 0);
  assertEquals(shardIndexForCursor(200, 200), 1);
  assertEquals(shardIndexForCursor(400, 200), 2);
});

Deno.test("isComplete is true once cursor reaches total", () => {
  assertEquals(isComplete(0, 450), false);
  assertEquals(isComplete(400, 450), false);
  assertEquals(isComplete(450, 450), true);
  assertEquals(isComplete(600, 450), true);
});

Deno.test("isFinalShard identifies the last shard from the cursor", () => {
  // 450 rows, size 200 → shards 0,1,2 ; final shard index = 2
  assertEquals(isFinalShard(0, 450, 200), false);
  assertEquals(isFinalShard(200, 450, 200), false);
  assertEquals(isFinalShard(400, 450, 200), true);
  // exact multiple: 400 rows → shards 0,1 ; final = 1
  assertEquals(isFinalShard(200, 400, 200), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test supabase/functions/process-upload/chunking.test.ts`
Expected: FAIL — `Module not found "./chunking.ts"`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/process-upload/chunking.ts`:

```ts
// Pure chunk math for the two-step ingest. No I/O — unit-tested in chunking.test.ts.

// Fixed-width shard names so storage listings sort naturally. Shards are addressed
// by computed name (not by listing), so widths beyond this just grow the prefix —
// names stay unique and correct. 5 digits covers ~20M rows at CHUNK_SIZE 200.
export const SHARD_PAD = 5;

export function shardName(index: number): string {
  return `parsed-${String(index).padStart(SHARD_PAD, "0")}.json`;
}

export interface ChunkRange {
  index: number;
  start: number; // inclusive
  end: number; // exclusive
}

// The slices parseStep writes, one shard per range.
export function chunkRanges(totalRows: number, chunkSize: number): ChunkRange[] {
  if (chunkSize <= 0) throw new Error("chunkSize must be > 0");
  const ranges: ChunkRange[] = [];
  let index = 0;
  for (let start = 0; start < totalRows; start += chunkSize, index++) {
    ranges.push({ index, start, end: Math.min(start + chunkSize, totalRows) });
  }
  return ranges;
}

export function shardIndexForCursor(cursor: number, chunkSize: number): number {
  return Math.floor(cursor / chunkSize);
}

export function isComplete(cursor: number, totalRows: number): boolean {
  return cursor >= totalRows;
}

export function isFinalShard(cursor: number, totalRows: number, chunkSize: number): boolean {
  return shardIndexForCursor(cursor, chunkSize) === shardIndexForCursor(totalRows - 1, chunkSize);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test supabase/functions/process-upload/chunking.test.ts`
Expected: PASS (all tests, ok).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-upload/chunking.ts supabase/functions/process-upload/chunking.test.ts
git commit -m "feat(upload): pure chunk-math helpers for sharded ingest"
```

---

## Task 2: Two-step routing + parse step + chaining skeleton (transport validation)

This task makes the function chain end-to-end **without writing any `incoming_cases` rows**, so the self-invoke transport, the sharded parse, the cursor lease, and chain termination are all proven before the ingest body is added in Task 3.

**Files:**
- Modify: `supabase/functions/process-upload/index.ts` (rewrite of the request handler + `ingest` → `parseStep`/`upsertStep`)

- [ ] **Step 1: Rewrite the top of `index.ts` (imports, constants, handler, helpers)**

Replace lines 1–66 (the imports through the end of `Deno.serve(...)`) with:

```ts
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { parseWorkbook, type ParsedRow } from "./parse.ts";
import { chunkRanges, isComplete, isFinalShard, shardIndexForCursor, shardName } from "./chunking.ts";

// Supabase runtime global (not in Deno's default lib types).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const CHUNK_SIZE = Number(Deno.env.get("CHUNK_SIZE") ?? 200);

type Step = "1_parsed_data" | "2_upsert_data";

// New Supabase API-key model: SUPABASE_SECRET_KEYS is a JSON dictionary of secret
// keys (sb_secret_...); its 'default' entry is the RLS-bypassing admin key that
// replaces the legacy SUPABASE_SERVICE_ROLE_KEY (which may be disabled once a project
// migrates to the new key system). Fall back to the legacy var only for older local CLIs.
function getSecretKey(): string {
  const dict = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (dict) {
    const keys = JSON.parse(dict) as Record<string, string>;
    if (keys.default) return keys.default;
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("No Supabase secret key (SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY)");
}

// Supabase query helpers reject with a PostgrestError — a plain object, NOT an Error
// instance — so `String(e)` yields "[object Object]". Pull the human-readable fields
// (message/details/hint/code) so a failed upload records what actually went wrong.
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts = [o.message, o.details, o.hint, o.code].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (parts.length) return parts.join(" — ");
  }
  return String(e);
}

// Fire the next link in the chain via an explicit HTTP call to this same function.
// NOT supabase-js functions.invoke — its Functions base-URL derivation from
// SUPABASE_URL inside the edge runtime is environment-specific. Awaiting this resolves
// at the 202 (the handler returns before EdgeRuntime.waitUntil work runs), so the
// current invocation ends cleanly and the next chunk gets a fresh wall-clock window.
async function selfInvokeUpsert(uploadId: string): Promise<void> {
  const key = getSecretKey();
  await fetch(`${SUPABASE_URL}/functions/v1/process-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify({ uploadId, step: "2_upsert_data" }),
  });
}

async function markFailed(admin: SupabaseClient, uploadId: string, e: unknown): Promise<void> {
  const { error: markErr } = await admin
    .from("uploads")
    .update({ status: "failed", error: errorMessage(e) })
    .eq("id", uploadId);
  if (markErr) {
    console.error(`upload ${uploadId}: failed to mark failed:`, markErr.message, "original:", e);
  }
}

Deno.serve(async (req) => {
  let uploadId: string | null = null;
  let step: Step = "1_parsed_data";
  try {
    const body = await req.json();
    uploadId = body.uploadId ?? null;
    if (body.step === "2_upsert_data") step = "2_upsert_data";
  } catch {
    uploadId = null;
  }
  if (!uploadId) {
    return Response.json({ error: "uploadId required" }, { status: 400 });
  }

  // Resolve the admin key at request time (not module load) so a missing env var
  // returns a clean 500 instead of crashing the function at cold start.
  let admin: SupabaseClient;
  try {
    admin = createClient(SUPABASE_URL, getSecretKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch (e) {
    console.error("process-upload: secret key unavailable:", e);
    return Response.json({ error: "server misconfigured" }, { status: 500 });
  }

  // Process in the background; return 202 immediately so the client just watches
  // Realtime. IMPORTANT: keep this return BEFORE any work — selfInvokeUpsert awaits
  // exactly this 202, so moving work above it would block the whole chain.
  const work = step === "2_upsert_data" ? upsertStep(admin, uploadId) : parseStep(admin, uploadId);
  EdgeRuntime.waitUntil(work);
  return Response.json({ accepted: true, uploadId, step }, { status: 202 });
});
```

- [ ] **Step 2: Replace `ingest()` with `parseStep()` and a skeleton `upsertStep()`**

Delete the entire existing `ingest(...)` function (old lines 68–195) and replace it with:

```ts
async function parseStep(admin: SupabaseClient, uploadId: string): Promise<void> {
  try {
    const { data: upload, error } = await admin.from("uploads").select("*").eq("id", uploadId).single();
    if (error || !upload) throw new Error(`upload ${uploadId} not found`);
    if (!upload.file_path) throw new Error("upload has no file_path");

    // total_rows stays null here so the client renders the "Parsing workbook…" phase.
    await admin.from("uploads").update({ status: "processing" }).eq("id", uploadId);

    const { data: file, error: dlErr } = await admin.storage.from("uploads").download(upload.file_path);
    if (dlErr || !file) throw new Error(`download failed: ${dlErr?.message ?? "no file"}`);

    const { rows, skipped } = parseWorkbook(new Uint8Array(await file.arrayBuffer()));
    // A workbook with no parseable detail sheet is a failure, not a 0-row success.
    if (rows.length === 0) {
      const reason = skipped.find((s) => s.reason === "no detail sheet found")?.reason ?? "no parseable rows found";
      throw new Error(reason);
    }

    // Write one shard per chunk. upsert:true so a re-run of parseStep overwrites cleanly.
    for (const r of chunkRanges(rows.length, CHUNK_SIZE)) {
      const slice = rows.slice(r.start, r.end);
      const { error: shErr } = await admin.storage.from("uploads").upload(
        `${uploadId}/${shardName(r.index)}`,
        new Blob([JSON.stringify(slice)], { type: "application/json" }),
        { upsert: true, contentType: "application/json" },
      );
      if (shErr) throw shErr;
    }

    // Reset cursor AND counters together: parseStep is re-runnable, so a re-parse must
    // rewind counters too or upsertStep would seed from stale totals and double-count.
    await admin.from("uploads").update({
      total_rows: rows.length,
      skipped_count: skipped.length,
      processed_rows: 0,
      inserted_count: 0,
      updated_count: 0,
      new_labs_count: 0,
      new_doctors_count: 0,
    }).eq("id", uploadId);

    await selfInvokeUpsert(uploadId);
  } catch (e) {
    await markFailed(admin, uploadId, e);
  }
}

async function upsertStep(admin: SupabaseClient, uploadId: string): Promise<void> {
  try {
    const { data: upload, error } = await admin.from("uploads").select("*").eq("id", uploadId).single();
    if (error || !upload) throw new Error(`upload ${uploadId} not found`);
    if (upload.status === "completed" || upload.status === "failed") return; // stray-invoke guard
    if (upload.total_rows == null) throw new Error("2_upsert_data invoked before parse finished");

    const cursor = upload.processed_rows;
    const total = upload.total_rows;
    if (isComplete(cursor, total)) {
      await admin.from("uploads").update({ status: "completed" }).eq("id", uploadId);
      return;
    }

    const shard = shardIndexForCursor(cursor, CHUNK_SIZE);
    const { data: file, error: dlErr } = await admin.storage
      .from("uploads")
      .download(`${uploadId}/${shardName(shard)}`);
    if (dlErr || !file) throw new Error(`shard ${shard} download failed: ${dlErr?.message ?? "missing"}`);
    const rows = JSON.parse(await file.text()) as ParsedRow[];

    // Runaway guard: a 0-row advance would self-invoke forever. A non-final shard must
    // be exactly CHUNK_SIZE (parse writes fixed slices) — anything else is corruption.
    if (rows.length === 0) throw new Error(`shard ${shard} is empty`);
    if (!isFinalShard(cursor, total, CHUNK_SIZE) && rows.length !== CHUNK_SIZE) {
      throw new Error(`non-final shard ${shard} has ${rows.length} rows, expected ${CHUNK_SIZE}`);
    }

    // Seed counters from the row so totals accumulate across chunks.
    const inserted = upload.inserted_count;
    const updated = upload.updated_count;
    const newLabs = upload.new_labs_count;
    const newDoctors = upload.new_doctors_count;

    // TASK 3 inserts the resolve + per-row upsert body here. Skeleton does no DB writes
    // and leaves the counters unchanged, so the chain can be validated in isolation.

    // Guarded cursor advance = the lease. Only the chain still holding `cursor` proceeds;
    // a concurrent invocation matches no row and stands down (no double-counting).
    const { data: advanced } = await admin
      .from("uploads")
      .update({
        processed_rows: cursor + rows.length,
        inserted_count: inserted,
        updated_count: updated,
        new_labs_count: newLabs,
        new_doctors_count: newDoctors,
      })
      .eq("id", uploadId)
      .eq("processed_rows", cursor)
      .select("id")
      .maybeSingle();
    if (!advanced) return;

    if (isComplete(cursor + rows.length, total)) {
      await admin.from("uploads").update({ status: "completed" }).eq("id", uploadId);
    } else {
      await selfInvokeUpsert(uploadId);
    }
  } catch (e) {
    await markFailed(admin, uploadId, e);
  }
}
```

- [ ] **Step 3: Typecheck the function with Deno**

Run: `deno check supabase/functions/process-upload/index.ts`
Expected: no errors. (Fix any type issues before proceeding.)

- [ ] **Step 4: Start local Supabase + serve the function**

Run (two terminals, or background the first):
```bash
npx supabase@latest start
CHUNK_SIZE=2 npx supabase@latest functions serve process-upload --no-verify-jwt
```
`CHUNK_SIZE=2` forces multiple shards from a tiny workbook so chaining is exercised. `--no-verify-jwt` lets the self-invoke (and your test invoke) through without a user JWT.

- [ ] **Step 5: Validate the chain end-to-end (the load-bearing test)**

Upload a small `.xlsx` (5–10 valid rows) through the app's upload dialog against local Supabase, OR insert an `uploads` row + upload the file to storage manually, then invoke:
```bash
curl -s -X POST http://127.0.0.1:54326/functions/v1/process-upload \
  -H "Content-Type: application/json" \
  -d '{"uploadId":"<the-upload-id>","step":"1_parsed_data"}'
```
Then watch the row:
```bash
# repeat a few times; processed_rows should climb by CHUNK_SIZE per chunk, then status=completed
npx supabase@latest db query "select status, total_rows, processed_rows from public.uploads where id = '<the-upload-id>'"
```
Expected:
- `parsed-00000.json`, `parsed-00001.json`, … appear under `uploads/<id>/` in Storage.
- `total_rows` is set; `processed_rows` advances 2 → 4 → … in separate invocations (function-serve logs show repeated `step: 2_upsert_data` requests).
- `status` ends at `completed` with `processed_rows == total_rows`.
- **No `incoming_cases` rows yet** (skeleton does no upserts) — confirm with `select count(*) from public.incoming_cases where upload_id = '<id>'` → 0.

**Troubleshooting (if the chain does not advance past the first chunk):** the self-invoke is not reaching the function. Check the function-serve logs for a fetch error in `selfInvokeUpsert`. The fix is the value of `SUPABASE_URL` inside the runtime — log it (`console.log("self-invoke base", SUPABASE_URL)`) and, if it is not reachable from inside the container, introduce a dedicated `FUNCTIONS_URL` env (e.g. `http://host.docker.internal:54326` locally) and use it in `selfInvokeUpsert` instead of `SUPABASE_URL`. Resolve this before Task 3.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/process-upload/index.ts
git commit -m "feat(upload): two-step routing, sharded parse, self-chaining skeleton"
```

---

## Task 3: Fill in the upsert body (resolve + per-row upsert)

Moves the existing per-row ingest logic into `upsertStep`, operating on the downloaded shard's rows and incrementing the seeded counters. After this task the function ingests real data.

**Files:**
- Modify: `supabase/functions/process-upload/index.ts` (`upsertStep` body)

- [ ] **Step 1: Replace the seed + TASK 3 marker block with the full ingest body**

In `upsertStep`, replace these lines:

```ts
    // Seed counters from the row so totals accumulate across chunks.
    const inserted = upload.inserted_count;
    const updated = upload.updated_count;
    const newLabs = upload.new_labs_count;
    const newDoctors = upload.new_doctors_count;

    // TASK 3 inserts the resolve + per-row upsert body here. Skeleton does no DB writes
    // and leaves the counters unchanged, so the chain can be validated in isolation.
```

with (note: counters become `let`; resolver Maps are per-invocation — rebuilt each chunk, which is correct because the SELECT-then-INSERT helpers still find rows created by earlier chunks):

```ts
    // Seed counters from the row so totals accumulate across chunks.
    let inserted = upload.inserted_count;
    let updated = upload.updated_count;
    let newLabs = upload.new_labs_count;
    let newDoctors = upload.new_doctors_count;

    // Per-invocation resolver caches. Rebuilt each chunk; the insert-if-absent helpers
    // still find rows created by earlier chunks, so cross-chunk correctness holds.
    const labs = new Map<string, number>();
    const products = new Map<string, number>();
    const doctors = new Map<string, number>();
    const patients = new Map<string, number>();

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

      if (existing) updated++;
      else inserted++;
    }
```

The guarded-update block below it is unchanged (it already writes `inserted`/`updated`/`newLabs`/`newDoctors`). Because the cursor only advances in that single guarded UPDATE — never mid-loop — the lease invariant holds and progress jumps one chunk (≤ `CHUNK_SIZE` rows) at a time.

- [ ] **Step 2: Typecheck**

Run: `deno check supabase/functions/process-upload/index.ts`
Expected: no errors.

- [ ] **Step 3: Re-serve and validate a full ingest against local Supabase**

Restart `functions serve` (still `CHUNK_SIZE=2`) and re-run the upload from Task 2 Step 5 with a **fresh** upload id.
Expected:
- `status` → `completed`, `processed_rows == total_rows`.
- `select count(*) from public.incoming_cases where upload_id = '<id>'` equals the number of unique rows in the workbook.
- `inserted_count + updated_count == total_rows`; for a first-time upload `inserted_count == total_rows`, `updated_count == 0`.
- Re-running the same workbook (new upload id) leaves `incoming_cases` count unchanged (dedupe_key upsert) and reports them as `updated_count`.

- [ ] **Step 4: Validate the cursor lease (no double-chain)**

With a multi-shard upload mid-flight (or replayed), invoke `2_upsert_data` twice in quick succession for the same `processing` upload:
```bash
curl -s -X POST http://127.0.0.1:54326/functions/v1/process-upload -H "Content-Type: application/json" -d '{"uploadId":"<id>","step":"2_upsert_data"}' &
curl -s -X POST http://127.0.0.1:54326/functions/v1/process-upload -H "Content-Type: application/json" -d '{"uploadId":"<id>","step":"2_upsert_data"}' &
wait
```
Expected: final counts still satisfy `inserted_count + updated_count == total_rows` (no double-count), `incoming_cases` has no duplicate rows, and the upload reaches `completed` exactly once.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-upload/index.ts
git commit -m "feat(upload): ingest sharded rows in upsertStep with cursor lease"
```

---

## Task 4: Client — pass the parse step

**Files:**
- Modify: `components/upload-dialog.tsx:342-345`

- [ ] **Step 1: Add the step to the invoke body**

Change:
```ts
          const { error: fnErr } = await supabase.functions.invoke(
            "process-upload",
            { body: { uploadId: id } }
          )
```
to:
```ts
          const { error: fnErr } = await supabase.functions.invoke(
            "process-upload",
            { body: { uploadId: id, step: "1_parsed_data" } }
          )
```

Nothing else in the dialog changes: the sequential-files loop, the Realtime subscription, `settleOnce`, the `SUBSCRIBED` guard, and `deriveProgress` all stay — the client still waits for the terminal `completed`/`failed` UPDATE, which now arrives at the end of the self-chain.

- [ ] **Step 2: Typecheck + lint**

Run: `yarn typecheck && yarn lint`
Expected: both pass, no new errors.

- [ ] **Step 3: Manual end-to-end through the UI**

With local Supabase + `functions serve` running, sign in as an admin, open the upload dialog, and upload a multi-shard workbook.
Expected progression in the dialog: "Parsing workbook…" (indeterminate) → "Ingesting 0/N rows" → percent climbs per chunk → "Completed · +N new". A second upload of the same file shows the duplicate guard (existing behavior, unaffected).

- [ ] **Step 4: Commit**

```bash
git add components/upload-dialog.tsx
git commit -m "feat(upload): invoke process-upload with 1_parsed_data step"
```

---

## Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run all automated checks**

Run:
```bash
deno test supabase/functions/process-upload/
yarn typecheck
yarn lint
```
Expected: Deno tests pass (chunking + parse), typecheck clean, lint clean.

- [ ] **Step 2: Run the spec's verification matrix against local Supabase**

Confirm each, with a fresh upload id per case:
- Small workbook (< CHUNK_SIZE rows) → one parse + one upsert chunk → `completed`, correct counts.
- Multi-shard workbook → `processed_rows` climbs per chunk, chain self-terminates at `completed`, counts match a single-pass ingest.
- Empty / headerless workbook → `failed` in `parseStep` ("no detail sheet found" / "no parseable rows found"), no shards consumed downstream.
- Re-invoke `2_upsert_data` on a `failed` mid-run upload → resumes from `processed_rows`, no duplicate `incoming_cases` rows.
- Re-invoke `1_parsed_data` on a partly-ingested upload → counters reset to 0 with the cursor; no carried-over double-count.

- [ ] **Step 3: Reset local DB to confirm a clean slate still works (optional but recommended)**

Run: `npx supabase@latest db reset` then repeat one happy-path upload.
Expected: ingest works from a freshly-seeded database.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(upload): verification fixes for chunked ingestion"
```

---

## Notes for the implementer

- **DRY:** the resolve/upsert body in Task 3 is moved verbatim from the old `ingest()`; do not rewrite its logic, only relocate it and switch the counters to seed from the upload row.
- **YAGNI:** no DB migration, no new status values, no interim per-row progress writes (progress jumps one chunk at a time — fine at `CHUNK_SIZE` 200). The optional iteration ceiling from the spec is *not* implemented unless Task 2/5 surfaces a real runaway; the empty-shard guard already prevents non-terminating chains.
- **The transport gate is real:** do not start Task 3 until Task 2 Step 5 shows the chain reaching `completed`. Everything downstream assumes the self-invoke works.
- **Default `CHUNK_SIZE` is 200 in production** (the env var is only lowered to 2 for local multi-shard testing); do not commit a lowered default.
