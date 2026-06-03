"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { Badge } from "@/components/ui/badge"
import { FileSpreadsheetIcon } from "lucide-react"
import type { Upload } from "@/lib/uploads"

const statusVariant: Record<Upload["status"], "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  processing: "secondary",
  completed: "default",
  failed: "destructive",
}

const statusLabel: Record<Upload["status"], string> = {
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
}

export const uploadColumns: ColumnDef<Upload>[] = [
  {
    accessorKey: "fileName",
    header: "File Name",
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <FileSpreadsheetIcon className="text-muted-foreground" data-icon="inline-start" />
        <span className="font-medium">{row.getValue("fileName")}</span>
      </div>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const status = row.getValue("status") as Upload["status"]
      return <Badge variant={statusVariant[status]}>{statusLabel[status]}</Badge>
    },
  },
  {
    id: "rows",
    header: "Progress",
    cell: ({ row }) => {
      const u = row.original
      if (u.status === "failed") {
        return (
          <span
            className="line-clamp-2 max-w-xs whitespace-normal text-xs text-destructive"
            title={u.error ?? "Failed"}
          >
            {u.error ?? "Failed"}
          </span>
        )
      }
      if (u.status === "processing" || u.status === "pending") {
        // totalRows is null until the workbook is parsed — show "Parsing…" until then
        // (don't fall back to processedRows here, which would read as a false 100%).
        const t = u.totalRows
        const percent = t ? Math.min(100, Math.round((u.processedRows / t) * 100)) : 0
        return (
          <span className="text-xs text-muted-foreground">
            {t ? `${percent}% · ${u.processedRows}/${t}` : "Parsing…"}
          </span>
        )
      }
      const total = u.totalRows ?? u.processedRows
      return (
        <span className="text-xs text-muted-foreground">
          {u.processedRows}/{total} · +{u.insertedCount} new
          {u.skippedCount > 0 ? ` · ${u.skippedCount} skipped` : ""}
        </span>
      )
    },
  },
  {
    accessorKey: "uploadedAt",
    header: "Date",
    cell: ({ row }) => {
      const date = new Date(row.getValue("uploadedAt") as string)
      return (
        <span className="text-muted-foreground">
          {date.toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}{" "}
          {date.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      )
    },
  },
  {
    accessorKey: "uploader",
    header: "Uploader",
  },
]
