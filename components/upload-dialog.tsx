"use client"

import { useState, useCallback, useRef } from "react"
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
import { cn } from "@/lib/utils"

const ACCEPTED = ".xlsx,.xls,.csv"

export function UploadDialog() {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function addFiles(incoming: FileList | null) {
    if (!incoming) return
    const valid = Array.from(incoming).filter((f) =>
      /\.(xlsx|xls|csv)$/i.test(f.name),
    )
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name + f.size))
      return [...prev, ...valid.filter((f) => !existing.has(f.name + f.size))]
    })
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  function reset() {
    setFiles([])
    setDragOver(false)
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    addFiles(e.dataTransfer.files)
  }, [])

  function handleUpload() {
    // TODO: implement actual upload logic
    setOpen(false)
    reset()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
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
            Drag and drop or browse to upload .xlsx, .xls, or .csv files.
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
              .xlsx, .xls, or .csv — multiple files allowed
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={files.length === 0}>
            <UploadIcon data-icon="inline-start" />
            Upload {files.length > 0 && `(${files.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
