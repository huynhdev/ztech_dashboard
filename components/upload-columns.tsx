"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { Badge } from "@/components/ui/badge"
import { FileSpreadsheetIcon } from "lucide-react"
import type { Upload } from "@/lib/data"

const statusVariant: Record<Upload["status"], "default" | "secondary" | "destructive"> = {
  completed: "default",
  processing: "secondary",
  failed: "destructive",
}

const statusLabel: Record<Upload["status"], string> = {
  completed: "Completed",
  processing: "Processing",
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
