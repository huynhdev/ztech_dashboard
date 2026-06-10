"use client"

import { memo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { TopEntity } from "@/lib/data"

interface TopTableProps {
  title: string
  data: TopEntity[]
}

export const TopTable = memo(function TopTable({ title, data }: TopTableProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8 text-xs">#</TableHead>
              <TableHead className="text-xs">Name</TableHead>
              <TableHead className="text-right text-xs">Cases</TableHead>
              <TableHead className="text-right text-xs">Revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item, i) => (
              <TableRow key={item.name}>
                <TableCell className="py-1.5 text-xs text-muted-foreground">
                  {i + 1}
                </TableCell>
                <TableCell className="max-w-[180px] truncate py-1.5 text-xs font-medium">
                  {item.name}
                </TableCell>
                <TableCell className="py-1.5 text-right text-xs">
                  {item.count}
                </TableCell>
                <TableCell className="py-1.5 text-right text-xs">
                  ${item.revenue.toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
})
