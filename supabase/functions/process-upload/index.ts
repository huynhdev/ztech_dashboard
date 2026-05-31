import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { parseWorkbook } from "./parse.ts";

// Supabase runtime global (not in Deno's default lib types).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const PROGRESS_EVERY = 50;

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
    // A workbook with no parseable detail sheet is a failure, not a 0-row success.
    if (rows.length === 0) {
      const reason = skipped.find((s) => s.reason === "no detail sheet found")?.reason ?? "no parseable rows found";
      throw new Error(reason);
    }
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

      if (existing) updated++;
      else inserted++;
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

    const { error: doneErr } = await admin.from("uploads").update({
      status: "completed",
      processed_rows: processed,
      inserted_count: inserted,
      updated_count: updated,
      new_labs_count: newLabs,
      new_doctors_count: newDoctors,
    }).eq("id", uploadId);
    // If this terminal write fails the row stays 'processing' and Realtime never
    // delivers a terminal event — surface it in the function logs.
    if (doneErr) console.error(`upload ${uploadId}: failed to mark completed:`, doneErr.message);
  } catch (e) {
    const { error: markErr } = await admin.from("uploads").update({
      status: "failed",
      error: errorMessage(e),
    }).eq("id", uploadId);
    if (markErr) {
      console.error(`upload ${uploadId}: failed to mark failed:`, markErr.message, "original:", e);
    }
  }
}
