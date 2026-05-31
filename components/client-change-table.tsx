"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ClientChange } from "@/lib/data";

interface ClientChangeTableProps {
  title: string;
  data: ClientChange[];
  variant: "new" | "churned";
  period: string;
}

export function ClientChangeTable({
  title,
  data,
  variant,
  period,
}: ClientChangeTableProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <Badge
            variant={variant === "new" ? "default" : "destructive"}
            className="text-[10px]"
          >
            {data.length} labs
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Compared period: {period}
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="max-h-[420px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8 text-xs">#</TableHead>
                <TableHead className="text-xs">Lab Name</TableHead>
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
              {data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="py-4 text-center text-xs text-muted-foreground"
                  >
                    No {variant} clients found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
