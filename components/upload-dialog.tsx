"use client"

import { useState, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { UploadIcon, FileSpreadsheetIcon, XIcon } from "lucide-react"
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

const ACCEPTED = ".xlsx"

type FileProgress = {
  fileName: string
  status: "pending" | "processing" | "completed" | "failed"
  processed: number
  total: number
  inserted: number
  skipped: number
  error: string | null
}

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
  return { percent, phase: `Ingesting ${p.processed}/${p.total} rows`, indeterminate: false }
}

export function UploadDialog() {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<Record<string, FileProgress>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const channelsRef = useRef<RealtimeChannel[]>([])
  const router = useRouter()

  function addFiles(incoming: FileList | null) {
    if (!incoming) return
    const valid = Array.from(incoming).filter((f) => /\.xlsx$/i.test(f.name))
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name + f.size))
      return [...prev, ...valid.filter((f) => !existing.has(f.name + f.size))]
    })
  }

  function removeFile(index: number) {
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
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    addFiles(e.dataTransfer.files)
  }, [])

  async function handleUpload() {
    if (files.length === 0) return
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
            { fileName: f.name, status: "failed", processed: 0, total: 0, inserted: 0, skipped: 0, error: "Not signed in" } as FileProgress,
          ]),
        ),
      )
      setUploading(false)
      return
    }

    const total = files.length
    let completed = 0
    const settle = () => {
      completed += 1
      if (completed === total) {
        setUploading(false)
        router.refresh()
      }
    }

    await Promise.all(
      files.map(async (file) => {
        const id = crypto.randomUUID()
        const path = `${id}/${file.name}`
        const set = (patch: Partial<FileProgress>) =>
          setProgress((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

        // Settle exactly once per file regardless of which terminal path fires
        // (synchronous error OR Realtime UPDATE), so the upload never hangs and
        // `completed` can't over-count.
        let settled = false
        const settleOnce = (channel?: RealtimeChannel) => {
          if (channel) supabase.removeChannel(channel)
          if (settled) return
          settled = true
          settle()
        }

        set({ fileName: file.name, status: "pending", processed: 0, total: 0, inserted: 0, skipped: 0, error: null })

        const { error: insErr } = await supabase
          .from("uploads")
          .insert({ id, file_name: file.name, file_path: path, status: "pending", uploaded_by: user.id })
        if (insErr) {
          set({ status: "failed", error: insErr.message })
          settleOnce()
          return
        }

        // Subscribe before invoking so the happy-path UPDATEs aren't missed. We do NOT
        // rely on this channel for liveness on the error paths below — those settle
        // directly — because the subscription may not be established yet when a fast
        // failure writes the row.
        const channel = supabase
          .channel(`upload-${id}`)
          .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "uploads", filter: `id=eq.${id}` },
            (payload) => {
              const n = payload.new as Record<string, number | string | null>
              set({
                status: String(n.status) as FileProgress["status"],
                processed: Number(n.processed_rows ?? 0),
                total: Number(n.total_rows ?? 0),
                inserted: Number(n.inserted_count ?? 0),
                skipped: Number(n.skipped_count ?? 0),
                error: (n.error as string | null) ?? null,
              })
              if (n.status === "completed" || n.status === "failed") settleOnce(channel)
            },
          )
          .subscribe()
        channelsRef.current.push(channel)

        const { error: upErr } = await supabase.storage.from("uploads").upload(path, file, { upsert: true })
        if (upErr) {
          set({ status: "failed", error: upErr.message })
          await supabase.from("uploads").update({ status: "failed", error: upErr.message }).eq("id", id)
          settleOnce(channel)
          return
        }

        const { error: fnErr } = await supabase.functions.invoke("process-upload", { body: { uploadId: id } })
        if (fnErr) {
          set({ status: "failed", error: fnErr.message })
          await supabase.from("uploads").update({ status: "failed", error: fnErr.message }).eq("id", id)
          settleOnce(channel)
        }
      }),
    )
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
      <DialogContent className="sm:max-w-lg">
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
                : "border-muted-foreground/25 hover:border-primary/50",
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
              {files.map((file, i) => (
                <div
                  key={file.name + file.size}
                  className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2"
                >
                  <FileSpreadsheetIcon className="shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <p className="truncate text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(file.size / 1024).toFixed(1)} KB
                    </p>
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
              ))}
            </div>
          )}

          {Object.keys(progress).length > 0 && (
            <div className="flex max-h-[240px] flex-col gap-2 overflow-y-auto">
              {Object.entries(progress).map(([id, p]) => {
                const { percent, phase, indeterminate } = deriveProgress(p)
                return (
                  <div key={id} className="flex flex-col gap-1 rounded-md border bg-muted/50 p-2.5">
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
                    <p className={cn("text-xs", p.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
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
          <Button variant="outline" onClick={() => setOpen(false)} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={files.length === 0 || uploading}>
            <UploadIcon data-icon="inline-start" />
            {uploading ? "Uploading…" : `Upload ${files.length > 0 ? `(${files.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
