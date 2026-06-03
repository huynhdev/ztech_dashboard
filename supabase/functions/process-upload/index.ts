import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2"
import { parseWorkbook, type ParsedRow } from "./parse.ts"
import {
  chunkRanges,
  isComplete,
  isFinalShard,
  shardIndexForCursor,
  shardName,
} from "./chunking.ts"

// Supabase runtime global (not in Deno's default lib types).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
// Each chunk is now a single import_upload_chunk() rpc (set-based, in-database), so the
// edge function does almost no per-row work and a chunk completes in well under a second.
// The chunk just bounds the rpc payload / DB statement size; keep it large so a file
// needs few chained invocations (785 rows ≈ 2 chunks at 500).
const CHUNK_SIZE = Number(Deno.env.get("CHUNK_SIZE") ?? 500)

type Step = "1_parsed_data" | "2_upsert_data"

// New Supabase API-key model: SUPABASE_SECRET_KEYS is a JSON dictionary of secret
// keys (sb_secret_...); its 'default' entry is the RLS-bypassing admin key that
// replaces the legacy SUPABASE_SERVICE_ROLE_KEY (which may be disabled once a project
// migrates to the new key system). Fall back to the legacy var only for older local CLIs.
function getSecretKey(): string {
  const dict = Deno.env.get("SUPABASE_SECRET_KEYS")
  if (dict) {
    const keys = JSON.parse(dict) as Record<string, string>
    if (keys.default) return keys.default
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (legacy) return legacy
  throw new Error(
    "No Supabase secret key (SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY)"
  )
}

// Supabase query helpers reject with a PostgrestError — a plain object, NOT an Error
// instance — so `String(e)` yields "[object Object]". Pull the human-readable fields
// (message/details/hint/code) so a failed upload records what actually went wrong.
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>
    const parts = [o.message, o.details, o.hint, o.code].filter(
      (v): v is string => typeof v === "string" && v.length > 0
    )
    if (parts.length) return parts.join(" — ")
  }
  return String(e)
}

// Fire the next link in the chain via an explicit HTTP call to this same function.
// NOT supabase-js functions.invoke — its Functions base-URL derivation from
// SUPABASE_URL inside the edge runtime is environment-specific. Awaiting this resolves
// at the 202 (the handler returns before EdgeRuntime.waitUntil work runs), so the
// current invocation ends cleanly and the next chunk gets a fresh wall-clock window.
//
// process-upload runs with verify_jwt = false, so the gateway does not validate this
// call. We authorize the internal self-invoke by sending the secret key on the `apikey`
// header — the documented pattern for the new sb_secret_ key model
// (https://supabase.com/docs/guides/api/api-keys: "implement your own apikey-header
// authorization logic inside the Edge Function"). NOT Authorization: the gateway (Kong)
// rewrites an `sb_secret_` Authorization into the corresponding role JWT before
// forwarding, so a bearer check would never match the secret; the apikey header is
// forwarded to the function intact.
// Tracing for the chunk-chain. Edge logs are the only window into the background
// (waitUntil) work, so log enough to locate where a chain stalls: which step booted,
// how far each chunk got, whether it advanced the cursor and chained or completed.
function log(
  uploadId: string,
  msg: string,
  extra?: Record<string, unknown>
): void {
  const tail = extra ? " " + JSON.stringify(extra) : ""
  console.log(`[process-upload ${uploadId}] ${msg}${tail}`)
}

async function selfInvokeUpsert(uploadId: string): Promise<void> {
  const key = getSecretKey()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
    },
    body: JSON.stringify({ uploadId, step: "2_upsert_data" }),
  })
  // A non-2xx here means the next link never started (e.g. apikey rejected by the
  // gateway/function). Surface it so the caller's catch marks the upload failed instead
  // of leaving it silently stuck on "processing".
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`self-invoke step 2 failed: ${res.status} ${detail}`.trim())
  }
  log(uploadId, "self-invoked step 2", { status: res.status })
}

// supabase-js functions.invoke() runs in the browser, so the call is cross-origin (the
// app on :6001 → the Functions host). Its apikey/authorization/x-client-info headers make
// it a non-simple request, so the browser sends a CORS preflight (OPTIONS) first. Without
// an OPTIONS short-circuit and Access-Control-* headers on responses, the preflight is
// rejected and invoke() fails with "Failed to send a request to the Edge Function".
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: { ...CORS_HEADERS, ...(init?.headers ?? {}) },
  })
}

async function markFailed(
  admin: SupabaseClient,
  uploadId: string,
  e: unknown
): Promise<void> {
  const { error: markErr } = await admin
    .from("uploads")
    .update({ status: "failed", error: errorMessage(e) })
    .eq("id", uploadId)
  if (markErr) {
    console.error(
      `upload ${uploadId}: failed to mark failed:`,
      markErr.message,
      "original:",
      e
    )
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  let uploadId: string | null = null
  let step: Step = "1_parsed_data"
  try {
    const body = await req.json()
    uploadId = body.uploadId ?? null
    if (body.step === "2_upsert_data") step = "2_upsert_data"
  } catch {
    uploadId = null
  }
  if (!uploadId) {
    return json({ error: "uploadId required" }, { status: 400 })
  }

  // Resolve the admin key at request time (not module load) so a missing env var
  // returns a clean 500 instead of crashing the function at cold start.
  let admin: SupabaseClient
  try {
    admin = createClient(SUPABASE_URL, getSecretKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  } catch (e) {
    console.error("process-upload: secret key unavailable:", e)
    return json({ error: "server misconfigured" }, { status: 500 })
  }

  // This function runs with verify_jwt = false (the project's sb_secret_ keys are not
  // JWTs the gateway can verify — same reason keepalive self-authorizes), so the function
  // guards itself by step:
  //  - 2_upsert_data (internal self-invoke): the `apikey` header must equal the secret
  //    key, which only the server knows. This is what makes the chain callable without a
  //    user JWT. (The browser only ever holds the publishable key, so it cannot forge it.)
  //  - 1_parsed_data (browser invoke): supabase-js attaches the signed-in user's JWT on
  //    Authorization; validate it so an anonymous caller cannot kick off processing.
  log(uploadId, "request received", { step, method: req.method })

  if (step === "2_upsert_data") {
    if (req.headers.get("apikey") !== getSecretKey()) {
      log(uploadId, "step 2 unauthorized: apikey mismatch")
      return json({ error: "unauthorized" }, { status: 401 })
    }
  } else {
    const bearer =
      req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? ""
    const {
      data: { user },
      error: authErr,
    } = await admin.auth.getUser(bearer)
    if (authErr || !user) {
      log(uploadId, "step 1 unauthorized: invalid user JWT", {
        authErr: authErr?.message ?? null,
      })
      return json({ error: "unauthorized" }, { status: 401 })
    }
  }

  // Process in the background; return 202 immediately so the client just watches
  // Realtime. IMPORTANT: keep this return BEFORE any work — selfInvokeUpsert awaits
  // exactly this 202, so moving work above it would block the whole chain.
  const work =
    step === "2_upsert_data"
      ? upsertStep(admin, uploadId)
      : parseStep(admin, uploadId)
  EdgeRuntime.waitUntil(work)
  return json({ accepted: true, uploadId, step }, { status: 202 })
})

async function parseStep(
  admin: SupabaseClient,
  uploadId: string
): Promise<void> {
  try {
    const { data: upload, error } = await admin
      .from("uploads")
      .select("*")
      .eq("id", uploadId)
      .single()
    if (error || !upload) throw new Error(`upload ${uploadId} not found`)
    if (!upload.file_path) throw new Error("upload has no file_path")

    // total_rows stays null here so the client renders the "Parsing workbook…" phase.
    await admin
      .from("uploads")
      .update({ status: "processing" })
      .eq("id", uploadId)

    const { data: file, error: dlErr } = await admin.storage
      .from("uploads")
      .download(upload.file_path)
    if (dlErr || !file)
      throw new Error(`download failed: ${dlErr?.message ?? "no file"}`)

    log(uploadId, "parse: downloaded file, parsing workbook")
    const { rows, skipped } = parseWorkbook(
      new Uint8Array(await file.arrayBuffer())
    )
    log(uploadId, "parse: workbook parsed", {
      rows: rows.length,
      skipped: skipped.length,
      chunkSize: CHUNK_SIZE,
    })
    // A workbook with no parseable detail sheet is a failure, not a 0-row success.
    if (rows.length === 0) {
      const reason =
        skipped.find((s) => s.kind === "header")?.reason ??
        "No parseable rows found. Every row was missing a patient, lab, or order date."
      throw new Error(reason)
    }

    // Write one shard per chunk. upsert:true so a re-run of parseStep overwrites each
    // shard cleanly. (A re-parse that produces FEWER shards leaves orphan high-index
    // shards from the prior run, but upsertStep only ever reads shards bounded by the
    // reset total_rows, so orphans are never read — harmless.)
    for (const r of chunkRanges(rows.length, CHUNK_SIZE)) {
      const slice = rows.slice(r.start, r.end)
      const { error: shErr } = await admin.storage
        .from("uploads")
        .upload(
          `${uploadId}/${shardName(r.index)}`,
          new Blob([JSON.stringify(slice)], { type: "application/json" }),
          { upsert: true, contentType: "application/json" }
        )
      if (shErr) throw shErr
    }

    // Reset cursor AND counters together: parseStep is re-runnable, so a re-parse must
    // rewind counters too or upsertStep would seed from stale totals and double-count.
    await admin
      .from("uploads")
      .update({
        total_rows: rows.length,
        skipped_count: skipped.length,
        processed_rows: 0,
        inserted_count: 0,
        updated_count: 0,
        new_labs_count: 0,
        new_doctors_count: 0,
      })
      .eq("id", uploadId)

    log(uploadId, "parse: shards written, handing off to step 2")
    await selfInvokeUpsert(uploadId)
  } catch (e) {
    log(uploadId, "parse: failed", { error: errorMessage(e) })
    await markFailed(admin, uploadId, e)
  }
}

async function upsertStep(
  admin: SupabaseClient,
  uploadId: string
): Promise<void> {
  try {
    const { data: upload, error } = await admin
      .from("uploads")
      .select("*")
      .eq("id", uploadId)
      .single()
    if (error || !upload) throw new Error(`upload ${uploadId} not found`)
    if (upload.status === "completed" || upload.status === "failed") return // stray-invoke guard
    if (upload.total_rows == null)
      throw new Error("2_upsert_data invoked before parse finished")

    const cursor = upload.processed_rows
    const total = upload.total_rows
    log(uploadId, "upsert: chunk start", { cursor, total })
    if (isComplete(cursor, total)) {
      await admin
        .from("uploads")
        .update({ status: "completed" })
        .eq("id", uploadId)
      log(uploadId, "upsert: already complete, marked completed")
      return
    }

    const shard = shardIndexForCursor(cursor, CHUNK_SIZE)
    const { data: file, error: dlErr } = await admin.storage
      .from("uploads")
      .download(`${uploadId}/${shardName(shard)}`)
    if (dlErr || !file)
      throw new Error(
        `shard ${shard} download failed: ${dlErr?.message ?? "missing"}`
      )
    const rows = JSON.parse(await file.text()) as ParsedRow[]

    // Runaway guard: a 0-row advance would self-invoke forever. A non-final shard must
    // be exactly CHUNK_SIZE (parse writes fixed slices) — anything else is corruption.
    if (rows.length === 0) throw new Error(`shard ${shard} is empty`)
    if (
      !isFinalShard(cursor, total, CHUNK_SIZE) &&
      rows.length !== CHUNK_SIZE
    ) {
      throw new Error(
        `non-final shard ${shard} has ${rows.length} rows, expected ${CHUNK_SIZE}`
      )
    }

    // Hand the whole chunk to Postgres. import_upload_chunk() resolves the
    // lab/product/doctor/patient dimensions and upserts incoming_cases set-based and
    // in-process — one rpc round-trip per chunk instead of ~6 PostgREST calls per row,
    // which is what made the old loop take ~30s/50 rows and get killed mid-chunk.
    const { data: counts, error: rpcErr } = await admin
      .rpc("import_upload_chunk", {
        p_upload_id: uploadId,
        p_source_file: upload.file_name,
        p_rows: rows,
      })
      .single()
    if (rpcErr) throw rpcErr
    const chunk = counts as {
      inserted_count: number
      updated_count: number
      new_labs_count: number
      new_doctors_count: number
    }

    // Accumulate this chunk's counts onto the upload's running totals.
    const inserted = upload.inserted_count + chunk.inserted_count
    const updated = upload.updated_count + chunk.updated_count
    const newLabs = upload.new_labs_count + chunk.new_labs_count
    const newDoctors = upload.new_doctors_count + chunk.new_doctors_count
    log(uploadId, "upsert: chunk imported via rpc", {
      rows: rows.length,
      ...chunk,
    })

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
      .maybeSingle()
    if (!advanced) {
      log(uploadId, "upsert: lost cursor lease, standing down", { cursor })
      return
    }

    const next = cursor + rows.length
    log(uploadId, "upsert: chunk done, cursor advanced", {
      processed: next,
      total,
      inserted,
      updated,
    })
    if (isComplete(next, total)) {
      await admin
        .from("uploads")
        .update({ status: "completed" })
        .eq("id", uploadId)
      log(uploadId, "upsert: all rows processed, marked completed")
    } else {
      await selfInvokeUpsert(uploadId)
    }
  } catch (e) {
    log(uploadId, "upsert: failed", { error: errorMessage(e) })
    await markFailed(admin, uploadId, e)
  }
}
