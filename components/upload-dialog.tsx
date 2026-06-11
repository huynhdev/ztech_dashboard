"use client"

import { useState, useRef } from "react"
import { useRouter } from "next/navigation"
import {
  UploadIcon,
  FileSpreadsheetIcon,
  XIcon,
  Loader2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { createClient } from "@/lib/supabase/client"
import type { RealtimeChannel } from "@supabase/supabase-js"
import { cn } from "@/lib/utils"
import { format } from "date-fns"
import { sha256Hex } from "@/lib/hash"
import type { Tables } from "@/types/database"

const ACCEPTED = ".xlsx"

// How long a non-terminal upload row may go without any change before the dialog
// declares it stalled. A killed edge worker (e.g. "CPU Time exceeded") never runs
// markFailed, so without this the row stays "processing" forever and blocks the
// sequential upload queue. Must comfortably exceed the longest legitimately silent
// window (the parse phase writes nothing between "processing" and total_rows) and
// stay below the 3-minute server-side fail_stalled_uploads() sweep.
const STALL_TIMEOUT_MS = 120_000

type FileProgress = {
  fileName: string
  status: "pending" | "processing" | "completed" | "failed"
  processed: number
  total: number
  inserted: number
  skipped: number
  error: string | null
}

type CheckStatus = "checking" | "ok" | "duplicate"
type FileCheck = {
  status: CheckStatus
  hash?: string
  dup?: { email: string; uploadedAt: string }
}

// Files are identified by name+size everywhere in this dialog: the dedupe in
// addFiles, the per-file check map, and the upload run all key off this.
const fileKey = (f: File) => f.name + f.size

function deriveProgress(p: FileProgress) {
  if (p.status === "completed")
    return { percent: 100, phase: "Completed", indeterminate: false }
  if (p.status === "failed")
    return { percent: 0, phase: "Failed", indeterminate: false }
  if (p.status === "pending")
    return { percent: 0, phase: "Uploading file…", indeterminate: true }
  // processing
  if (!p.total)
    return { percent: 0, phase: "Parsing workbook…", indeterminate: true }
  const percent = Math.min(100, Math.round((p.processed / p.total) * 100))
  return {
    percent,
    phase: `Ingesting ${p.processed}/${p.total} rows`,
    indeterminate: false,
  }
}

export function UploadDialog() {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<Record<string, FileProgress>>({})
  const [checks, setChecks] = useState<Record<string, FileCheck>>({})
  // React StrictMode invokes the setFiles updater twice in dev; this ref makes the
  // per-file hash+query fire at most once per file across those double invocations.
  const checkingRef = useRef<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const channelsRef = useRef<RealtimeChannel[]>([])
  const router = useRouter()

  async function checkFile(file: File) {
    const key = fileKey(file)
    if (checkingRef.current.has(key)) return
    checkingRef.current.add(key)
    setChecks((prev) => ({ ...prev, [key]: { status: "checking" } }))

    // Fail open if the hash/query stalls (not just rejects): never let a hung
    // request silently leave a file stuck in "checking" and out of the upload run.
    // Mirrors the 5s SUBSCRIBED guard below. If the real check resolves first this
    // is a no-op; if it resolves later it overwrites with the true verdict.
    setTimeout(() => {
      setChecks((prev) =>
        prev[key]?.status === "checking"
          ? { ...prev, [key]: { status: "ok" } }
          : prev
      )
    }, 10000)

    try {
      const hash = await sha256Hex(file)
      const supabase = createClient()
      const { data } = await supabase
        .from("uploads")
        .select("uploaded_at, profiles(email)")
        .eq("file_hash", hash)
        .eq("status", "completed")
        .limit(1)
        .maybeSingle()

      if (data) {
        const email =
          (data.profiles as unknown as Pick<Tables<"profiles">, "email"> | null)
            ?.email ?? "—"
        setChecks((prev) => ({
          ...prev,
          [key]: {
            status: "duplicate",
            hash,
            dup: { email, uploadedAt: data.uploaded_at },
          },
        }))
      } else {
        setChecks((prev) => ({ ...prev, [key]: { status: "ok", hash } }))
      }
    } catch {
      // Fail open: a transient hash/network error must never block a legitimate
      // upload. The pre-insert re-check in processFile is the second line of defense.
      setChecks((prev) => ({ ...prev, [key]: { status: "ok" } }))
    }
  }

  function addFiles(incoming: FileList | null) {
    if (!incoming) return
    const valid = Array.from(incoming).filter((f) => /\.xlsx$/i.test(f.name))
    setFiles((prev) => {
      const existing = new Set(prev.map(fileKey))
      const next = [...prev]
      for (const f of valid) {
        const key = fileKey(f)
        if (existing.has(key)) continue
        existing.add(key)
        next.push(f)
        void checkFile(f)
      }
      return next
    })
  }

  function removeFile(index: number) {
    const removed = files[index]
    if (removed) {
      const key = fileKey(removed)
      checkingRef.current.delete(key)
      setChecks((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  function reset() {
    const supabase = createClient()
    for (const ch of channelsRef.current) supabase.removeChannel(ch)
    channelsRef.current = []
    setFiles([])
    setDragOver(false)
    setUploading(false)
    setProgress({})
    setChecks({})
    checkingRef.current = new Set()
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    addFiles(e.dataTransfer.files)
  }

  const readyFiles = files.filter((f) => checks[fileKey(f)]?.status === "ok")

  async function handleUpload() {
    if (readyFiles.length === 0) return
    setUploading(true)

    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      setProgress(
        Object.fromEntries(
          files.map((f) => [
            f.name,
            {
              fileName: f.name,
              status: "failed",
              processed: 0,
              total: 0,
              inserted: 0,
              skipped: 0,
              error: "Not signed in",
            } as FileProgress,
          ])
        )
      )
      setUploading(false)
      return
    }

    // Each ingest creates labs/doctors/products/patients with an insert-if-absent
    // check (SELECT then INSERT). Two ingests running at once both miss the SELECT
    // and both INSERT the same name, so one loses on a UNIQUE-constraint violation.
    // Process files one at a time — waiting for each to reach a terminal state before
    // starting the next — so their ingests never overlap. (The function returns 202
    // and ingests in the background, so a sequential *invoke* is not enough; we must
    // wait for the terminal Realtime UPDATE.)
    const processFile = (file: File) =>
      new Promise<void>((resolveFile) => {
        const id = crypto.randomUUID()
        const path = `${id}/${file.name}`
        const set = (patch: Partial<FileProgress>) =>
          setProgress((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

        // Resolve exactly once per file regardless of which terminal path fires
        // (synchronous error, terminal Realtime UPDATE, or the polling fallback), so the
        // sequence never hangs.
        let settled = false
        let pollTimer: ReturnType<typeof setInterval> | undefined
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined
        let reconnectAttempts = 0
        let activeChannel: RealtimeChannel | undefined
        let openGate: (() => void) | undefined

        const settleOnce = () => {
          if (reconnectTimer) clearTimeout(reconnectTimer)
          if (pollTimer) clearInterval(pollTimer)
          if (activeChannel) {
            supabase.removeChannel(activeChannel)
            activeChannel = undefined
          }
          if (settled) return
          settled = true
          resolveFile()
        }

        // Stall detection: applyRow snapshots the fields below, so any real progress
        // (from Realtime or the poll) refreshes lastChangeAt. The clock starts when the
        // poll starts (after the function invoke) — storage upload time never counts.
        let lastChangeAt = Date.now()
        let lastSnapshot = ""

        // One place to apply a row snapshot to the UI — shared by the Realtime UPDATE, the
        // resubscribe refetch, and the poll — settling once the row reaches a terminal state.
        const applyRow = (r: Record<string, number | string | null>) => {
          const snapshot = JSON.stringify([
            r.status,
            r.processed_rows,
            r.total_rows,
            r.inserted_count,
            r.skipped_count,
            r.error,
          ])
          if (snapshot !== lastSnapshot) {
            lastSnapshot = snapshot
            lastChangeAt = Date.now()
          }
          set({
            status: String(r.status) as FileProgress["status"],
            processed: Number(r.processed_rows ?? 0),
            total: Number(r.total_rows ?? 0),
            inserted: Number(r.inserted_count ?? 0),
            skipped: Number(r.skipped_count ?? 0),
            error: (r.error as string | null) ?? null,
          })
          if (r.status === "completed" || r.status === "failed") settleOnce()
        }

        const refetchRow = async () => {
          const { data: row } = await supabase
            .from("uploads")
            .select(
              "status, processed_rows, total_rows, inserted_count, skipped_count, error"
            )
            .eq("id", id)
            .maybeSingle()
          if (row) applyRow(row)
        }

        // Auto-reconnect: a dropped/reconnected socket can rejoin the channel but lose its
        // postgres_changes binding (a known Realtime issue), so UPDATEs silently stop. On
        // any non-SUBSCRIBED status, rebuild the channel from scratch (capped, with
        // backoff); on every (re)subscribe, refetch once to fill the gap. The poll below
        // remains the final backstop so the file still settles if every reconnect fails.
        const buildChannel = () => {
          if (activeChannel) supabase.removeChannel(activeChannel)
          const ch = supabase.channel(`upload-${id}`).on(
            "postgres_changes",
            {
              event: "UPDATE",
              schema: "public",
              table: "uploads",
              filter: `id=eq.${id}`,
            },
            (payload) =>
              applyRow(payload.new as Record<string, number | string | null>)
          )
          activeChannel = ch
          channelsRef.current.push(ch)
          ch.subscribe((status) => {
            if (settled || ch !== activeChannel) return
            if (status === "SUBSCRIBED") {
              reconnectAttempts = 0
              openGate?.()
              openGate = undefined
              void refetchRow()
            } else if (
              status === "CHANNEL_ERROR" ||
              status === "TIMED_OUT" ||
              status === "CLOSED"
            ) {
              if (reconnectAttempts >= 6) return
              reconnectAttempts++
              reconnectTimer = setTimeout(
                buildChannel,
                Math.min(1000 * 2 ** (reconnectAttempts - 1), 15000)
              )
            }
          })
        }

        void (async () => {
          set({
            fileName: file.name,
            status: "pending",
            processed: 0,
            total: 0,
            inserted: 0,
            skipped: 0,
            error: null,
          })

          const hash = checks[fileKey(file)]?.hash ?? null

          // Guard the window between add-time check and this click: a matching file may
          // have completed in between. Cheap, and only runs for files already marked ok.
          if (hash) {
            const { data: dup } = await supabase
              .from("uploads")
              .select("id")
              .eq("file_hash", hash)
              .eq("status", "completed")
              .limit(1)
              .maybeSingle()
            if (dup) {
              set({ status: "failed", error: "Already uploaded" })
              settleOnce()
              return
            }
          }

          const { error: insErr } = await supabase.from("uploads").insert({
            id,
            file_name: file.name,
            file_path: path,
            status: "pending",
            uploaded_by: user.id,
            file_hash: hash,
          })
          if (insErr) {
            set({ status: "failed", error: insErr.message })
            settleOnce()
            return
          }

          // Subscribe before invoking so the happy-path UPDATEs aren't missed, and wait
          // until SUBSCRIBED (or a 5s fallback) before kicking off work that could finish
          // near-instantly — otherwise a terminal UPDATE fired before the subscription is
          // live would be missed. buildChannel owns reconnection from here on; the error
          // paths below settle directly since the subscription may not be live yet.
          buildChannel()
          await new Promise<void>((resolve) => {
            openGate = resolve
            setTimeout(resolve, 5000)
          })

          const { error: upErr } = await supabase.storage
            .from("uploads")
            .upload(path, file, { upsert: true })
          if (upErr) {
            set({ status: "failed", error: upErr.message })
            await supabase
              .from("uploads")
              .update({ status: "failed", error: upErr.message })
              .eq("id", id)
            settleOnce()
            return
          }

          const { error: fnErr } = await supabase.functions.invoke(
            "process-upload",
            { body: { uploadId: id, step: "1_parsed_data" } }
          )
          if (fnErr) {
            set({ status: "failed", error: fnErr.message })
            await supabase
              .from("uploads")
              .update({ status: "failed", error: fnErr.message })
              .eq("id", id)
            settleOnce()
            return
          }

          // Watchdog: a worker killed by the runtime (CPU/memory limit) bypasses the
          // function's catch, so the row never reaches a terminal state on its own.
          // Mark it failed — guarded to lose against a terminal update racing in, in
          // which case the refetch picks up the real outcome and settles normally.
          const failStalled = async () => {
            const msg =
              "Processing stalled: the server stopped reporting progress. Re-upload the file to retry."
            const { data: updated } = await supabase
              .from("uploads")
              .update({ status: "failed", error: msg })
              .eq("id", id)
              .in("status", ["pending", "processing"])
              .select("id")
              .maybeSingle()
            if (updated) {
              set({ status: "failed", error: msg })
              settleOnce()
            } else {
              void refetchRow()
            }
          }

          // Final backstop (see buildChannel): poll the row from the DB so the file still
          // settles and stays in sync even if Realtime never recovers.
          lastChangeAt = Date.now()
          pollTimer = setInterval(() => {
            if (Date.now() - lastChangeAt > STALL_TIMEOUT_MS) {
              void failStalled()
              return
            }
            void refetchRow()
          }, 3000)
        })()
      })

    for (const file of readyFiles) {
      await processFile(file)
    }

    // These files have reached a terminal state and now live in the `progress` section
    // (keyed by upload id). Drop them from the pending list + checks so the Upload button
    // no longer counts them as ready to (re)upload — otherwise it keeps showing e.g.
    // "Upload (2)" after a completed run.
    const processedKeys = new Set(readyFiles.map(fileKey))
    setFiles((prev) => prev.filter((f) => !processedKeys.has(fileKey(f))))
    setChecks((prev) => {
      const next = { ...prev }
      for (const key of processedKeys) delete next[key]
      return next
    })
    for (const key of processedKeys) checkingRef.current.delete(key)

    setUploading(false)
    router.refresh()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && uploading) return // don't close (or reset) while uploads are in flight
        setOpen(v)
        if (!v) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UploadIcon data-icon="inline-start" />
          Upload Files
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-lg"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Upload Excel Files</DialogTitle>
          <DialogDescription>
            Drag and drop or browse to upload .xlsx — multiple files allowed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <button
            type="button"
            className={cn(
              "flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors",
              dragOver
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-primary/50"
            )}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <UploadIcon className="text-muted-foreground" />
            <p className="text-sm font-medium">
              Drop files here or click to browse
            </p>
            <p className="text-xs text-muted-foreground">
              .xlsx — multiple files allowed
            </p>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ""
              }}
            />
          </button>

          {files.length > 0 && (
            <div className="flex max-h-[200px] flex-col gap-2 overflow-y-auto">
              {files.map((file, i) => {
                const check = checks[fileKey(file)]
                return (
                  <div
                    key={fileKey(file)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2",
                      check?.status === "duplicate"
                        ? "border-destructive/40 bg-destructive/5"
                        : "bg-muted/50"
                    )}
                  >
                    <FileSpreadsheetIcon className="shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <p className="truncate text-sm font-medium">
                        {file.name}
                      </p>
                      {check?.status === "checking" ? (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Loader2Icon className="size-3 animate-spin" />
                          Checking for duplicates…
                        </p>
                      ) : check?.status === "duplicate" ? (
                        <p className="text-xs text-destructive">
                          Already uploaded · {check.dup?.email} ·{" "}
                          {check.dup
                            ? format(
                                new Date(check.dup.uploadedAt),
                                "MMM d, yyyy"
                              )
                            : ""}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {(file.size / 1024).toFixed(1)} KB
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      onClick={() => removeFile(i)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}

          {Object.keys(progress).length > 0 && (
            <div className="flex max-h-[240px] flex-col gap-2 overflow-y-auto">
              {Object.entries(progress).map(([id, p]) => {
                const { percent, phase, indeterminate } = deriveProgress(p)
                return (
                  <div
                    key={id}
                    className="flex flex-col gap-1 rounded-md border bg-muted/50 p-2.5"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate font-medium">{p.fileName}</span>
                      <span className="font-mono text-muted-foreground">
                        {indeterminate ? "…" : `${percent}%`}
                      </span>
                    </div>
                    <Progress
                      value={indeterminate ? undefined : percent}
                      className={indeterminate ? "animate-pulse" : undefined}
                    />
                    <p
                      className={cn(
                        "text-xs",
                        p.status === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground"
                      )}
                    >
                      {p.status === "failed"
                        ? (p.error ?? "Failed")
                        : p.status === "completed"
                          ? `Completed · +${p.inserted} new${p.skipped > 0 ? ` · ${p.skipped} skipped` : ""}`
                          : phase}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={readyFiles.length === 0 || uploading}
          >
            <UploadIcon data-icon="inline-start" />
            {uploading
              ? "Uploading…"
              : `Upload ${readyFiles.length > 0 ? `(${readyFiles.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
