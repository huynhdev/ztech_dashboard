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
const CHUNK_SIZE = Number(Deno.env.get("CHUNK_SIZE") ?? 200)

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
async function selfInvokeUpsert(uploadId: string): Promise<void> {
  const key = getSecretKey()
  await fetch(`${SUPABASE_URL}/functions/v1/process-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
    },
    body: JSON.stringify({ uploadId, step: "2_upsert_data" }),
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
    return Response.json({ error: "uploadId required" }, { status: 400 })
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
    return Response.json({ error: "server misconfigured" }, { status: 500 })
  }

  // This function runs with verify_jwt = false (the project's sb_secret_ keys are not
  // JWTs the gateway can verify — same reason keepalive self-authorizes), so the function
  // guards itself by step:
  //  - 2_upsert_data (internal self-invoke): the `apikey` header must equal the secret
  //    key, which only the server knows. This is what makes the chain callable without a
  //    user JWT. (The browser only ever holds the publishable key, so it cannot forge it.)
  //  - 1_parsed_data (browser invoke): supabase-js attaches the signed-in user's JWT on
  //    Authorization; validate it so an anonymous caller cannot kick off processing.
  if (step === "2_upsert_data") {
    if (req.headers.get("apikey") !== getSecretKey()) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
  } else {
    const bearer =
      req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? ""
    const {
      data: { user },
      error: authErr,
    } = await admin.auth.getUser(bearer)
    if (authErr || !user) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
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
  return Response.json({ accepted: true, uploadId, step }, { status: 202 })
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

    const { rows, skipped } = parseWorkbook(
      new Uint8Array(await file.arrayBuffer())
    )
    // A workbook with no parseable detail sheet is a failure, not a 0-row success.
    if (rows.length === 0) {
      const reason =
        skipped.find((s) => s.reason === "no detail sheet found")?.reason ??
        "no parseable rows found"
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

    await selfInvokeUpsert(uploadId)
  } catch (e) {
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
    if (isComplete(cursor, total)) {
      await admin
        .from("uploads")
        .update({ status: "completed" })
        .eq("id", uploadId)
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

    // Seed counters from the row so totals accumulate across chunks.
    let inserted = upload.inserted_count
    let updated = upload.updated_count
    let newLabs = upload.new_labs_count
    let newDoctors = upload.new_doctors_count

    // Per-invocation resolver caches. Rebuilt each chunk; the insert-if-absent helpers
    // still find rows created by earlier chunks, so cross-chunk correctness holds.
    const labs = new Map<string, number>()
    const products = new Map<string, number>()
    const doctors = new Map<string, number>()
    const patients = new Map<string, number>()

    const resolveLab = async (name: string): Promise<number> => {
      if (labs.has(name)) return labs.get(name)!
      const { data: ex } = await admin
        .from("labs")
        .select("id")
        .eq("name", name)
        .maybeSingle()
      if (ex) {
        labs.set(name, ex.id)
        return ex.id
      }
      const { data: ins, error } = await admin
        .from("labs")
        .insert({ name })
        .select("id")
        .single()
      if (error) throw error
      newLabs++
      labs.set(name, ins.id)
      return ins.id
    }

    const resolveProduct = async (
      name: string,
      category: string
    ): Promise<number> => {
      if (products.has(name)) return products.get(name)!
      const { data: ex } = await admin
        .from("products")
        .select("id")
        .eq("name", name)
        .maybeSingle()
      if (ex) {
        products.set(name, ex.id)
        return ex.id
      }
      const { data: ins, error } = await admin
        .from("products")
        .insert({ name, category })
        .select("id")
        .single()
      if (error) throw error
      products.set(name, ins.id)
      return ins.id
    }

    const resolveDoctor = async (
      raw: string,
      name: string,
      route: string | null,
      labId: number
    ): Promise<number> => {
      if (doctors.has(raw)) return doctors.get(raw)!
      const { data: ex } = await admin
        .from("doctors")
        .select("id")
        .eq("raw", raw)
        .maybeSingle()
      if (ex) {
        doctors.set(raw, ex.id)
        return ex.id
      }
      const { data: ins, error } = await admin
        .from("doctors")
        .insert({ raw, name, route, lab_id: labId })
        .select("id")
        .single()
      if (error) throw error
      newDoctors++
      doctors.set(raw, ins.id)
      return ins.id
    }

    const resolvePatient = async (
      name: string,
      externalId: string | null,
      labId: number
    ): Promise<number> => {
      const key = `${name}|${externalId ?? ""}|${labId}`
      if (patients.has(key)) return patients.get(key)!
      let q = admin
        .from("patients")
        .select("id")
        .eq("name", name)
        .eq("lab_id", labId)
      q =
        externalId === null
          ? q.is("external_id", null)
          : q.eq("external_id", externalId)
      const { data: ex } = await q.maybeSingle()
      if (ex) {
        patients.set(key, ex.id)
        return ex.id
      }
      const { data: ins, error } = await admin
        .from("patients")
        .insert({ name, external_id: externalId, lab_id: labId })
        .select("id")
        .single()
      if (error) throw error
      patients.set(key, ins.id)
      return ins.id
    }

    for (const row of rows) {
      const labId = await resolveLab(row.lab)
      const productId = await resolveProduct(row.productName, row.category)
      const doctorId = await resolveDoctor(
        row.doctorRaw,
        row.doctorName,
        row.route,
        labId
      )
      const patientId = await resolvePatient(
        row.patientName,
        row.externalId,
        labId
      )
      const dedupeKey = `${row.pan}|${row.orderDate}|${patientId}|${productId}`

      const { data: existing } = await admin
        .from("incoming_cases")
        .select("id")
        .eq("dedupe_key", dedupeKey)
        .maybeSingle()

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
        { onConflict: "dedupe_key" }
      )
      if (upErr) throw upErr

      if (existing) updated++
      else inserted++
    }

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
    if (!advanced) return

    if (isComplete(cursor + rows.length, total)) {
      await admin
        .from("uploads")
        .update({ status: "completed" })
        .eq("id", uploadId)
    } else {
      await selfInvokeUpsert(uploadId)
    }
  } catch (e) {
    await markFailed(admin, uploadId, e)
  }
}
