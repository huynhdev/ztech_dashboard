"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { Tables } from "@/types/database"
import { UserRowActions } from "@/components/user-row-actions"

export type UserRow = Pick<
  Tables<"profiles">,
  "id" | "full_name" | "email" | "role" | "status" | "created_at"
>

export const userColumns: ColumnDef<UserRow>[] = [
  {
    accessorKey: "full_name",
    header: "Name",
    cell: ({ row }) => (
      <span className="font-medium">{row.getValue("full_name") ?? "—"}</span>
    ),
  },
  {
    accessorKey: "email",
    header: "Email",
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.getValue("email")}</span>
    ),
  },
  {
    accessorKey: "created_at",
    header: "Created",
    cell: ({ row }) => {
      const date = new Date(row.getValue("created_at") as string)
      return (
        <span className="text-muted-foreground">
          {date.toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </span>
      )
    },
  },
  {
    id: "actions",
    cell: ({ row }) => <UserRowActions user={row.original} />,
  },
]
