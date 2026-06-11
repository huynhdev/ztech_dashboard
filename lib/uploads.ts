import { createClient } from "@/lib/supabase/server"
import type { Enums, Tables } from "@/types/database"

// Derived from the generated DB enum so the two can never drift; a new enum
// variant surfaces as a compile error wherever UploadStatus is exhaustively handled.
export type UploadStatus = Enums<"upload_status">

export type Upload = {
  id: string
  fileName: string
  status: UploadStatus
  uploadedAt: string
  uploader: string
  totalRows: number | null
  processedRows: number
  insertedCount: number
  updatedCount: number
  skippedCount: number
  newLabsCount: number
  newDoctorsCount: number
  error: string | null
}

export async function getUploads(): Promise<Upload[]> {
  const supabase = await createClient()

  // Watchdog sweep: a killed edge worker (e.g. "CPU Time exceeded") never runs
  // markFailed, so its row would sit in 'processing' forever. Fail stalled rows
  // before listing so the page always shows a truthful, retryable state.
  const { error: sweepError } = await supabase.rpc("fail_stalled_uploads")
  if (sweepError) {
    console.error("[getUploads] stall sweep failed:", sweepError.message)
  }

  const { data, error } = await supabase
    .from("uploads")
    .select(
      "id, file_name, status, uploaded_at, total_rows, processed_rows, inserted_count, updated_count, skipped_count, new_labs_count, new_doctors_count, error, profiles(email)"
    )
    .order("uploaded_at", { ascending: false })

  if (error) {
    console.error("[getUploads] Supabase error:", error.message, error.code)
    return []
  }
  if (!data) return []

  return data.map((u) => ({
    id: u.id,
    fileName: u.file_name,
    status: u.status,
    uploadedAt: u.uploaded_at,
    // supabase-js types this many-to-one embed as an array, but a to-one embed
    // returns a single object at runtime; bridge via unknown while keeping the
    // generated-profile anchor so a renamed `email` column still fails to compile.
    uploader:
      (u.profiles as unknown as Pick<Tables<"profiles">, "email"> | null)
        ?.email ?? "—",
    totalRows: u.total_rows,
    processedRows: u.processed_rows,
    insertedCount: u.inserted_count,
    updatedCount: u.updated_count,
    skippedCount: u.skipped_count,
    newLabsCount: u.new_labs_count,
    newDoctorsCount: u.new_doctors_count,
    error: u.error,
  }))
}
