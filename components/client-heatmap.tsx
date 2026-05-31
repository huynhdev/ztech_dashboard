"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { getClientHeatmap, type CaseRow, type HeatmapSort } from "@/lib/data";

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function getDayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
}

function getCellColor(count: number, max: number): string {
  if (count === 0) return "bg-muted/40";
  const ratio = count / max;
  if (ratio <= 0.15) return "bg-emerald-200 dark:bg-emerald-900/60";
  if (ratio <= 0.35) return "bg-emerald-300 dark:bg-emerald-700/70";
  if (ratio <= 0.6) return "bg-emerald-400 dark:bg-emerald-600/80";
  if (ratio <= 0.8) return "bg-emerald-500 dark:bg-emerald-500";
  return "bg-emerald-600 dark:bg-emerald-400";
}

export function ClientHeatmap({ cases }: { cases: CaseRow[] }) {
  const [sort, setSort] = useState<HeatmapSort>("last-active");
  const [limit, setLimit] = useState(40);

  const data = useMemo(
    () => getClientHeatmap(cases, limit, sort),
    [cases, limit, sort],
  );

  const [tooltip, setTooltip] = useState<{
    lab: string;
    date: string;
    count: number;
    x: number;
    y: number;
  } | null>(null);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-medium">
              Client Activity Heatmap
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each cell = case count per lab per day. Blank = no orders.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={String(limit)}
              onValueChange={(v) => setLimit(Number(v))}
            >
              <SelectTrigger className="h-7 w-[90px] cursor-pointer text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="20" className="cursor-pointer text-xs">
                  Top 20
                </SelectItem>
                <SelectItem value="40" className="cursor-pointer text-xs">
                  Top 40
                </SelectItem>
                <SelectItem value="80" className="cursor-pointer text-xs">
                  Top 80
                </SelectItem>
                <SelectItem value="220" className="cursor-pointer text-xs">
                  All labs
                </SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={sort}
              onValueChange={(v) => setSort(v as HeatmapSort)}
            >
              <SelectTrigger className="h-7 w-[130px] cursor-pointer text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="last-active"
                  className="cursor-pointer text-xs"
                >
                  Last Active
                </SelectItem>
                <SelectItem
                  value="total-cases"
                  className="cursor-pointer text-xs"
                >
                  Total Cases
                </SelectItem>
                <SelectItem value="name" className="cursor-pointer text-xs">
                  Name A-Z
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="relative pt-0">
        <div className="overflow-x-auto">
          <div className="min-w-[700px]">
            {/* Date header row */}
            <div className="mb-1 flex">
              <div className="w-[160px] shrink-0" />
              <div className="flex flex-1 gap-px">
                {data.dates.map((d) => (
                  <div
                    key={d}
                    className="flex min-w-0 flex-1 flex-col items-center"
                  >
                    <span className="text-[9px] leading-tight text-muted-foreground">
                      {getDayOfWeek(d)}
                    </span>
                    <span className="text-[10px] font-medium leading-tight">
                      {formatDateLabel(d)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="w-[50px] shrink-0" />
            </div>

            {/* Heatmap rows */}
            <div className="max-h-[600px] overflow-y-auto">
              {data.rows.map((row) => (
                <div
                  key={row.labId ?? "unknown"}
                  className="group flex items-center py-px"
                >
                  <div
                    className="w-[160px] shrink-0 truncate pr-2 text-[11px] leading-tight"
                    title={row.labName}
                  >
                    {row.labName}
                  </div>
                  <div className="flex flex-1 gap-px">
                    {data.dates.map((d) => {
                      const count = row.cells[d] ?? 0;
                      return (
                        <div
                          key={d}
                          className={`flex aspect-square min-w-0 flex-1 cursor-pointer items-center justify-center rounded-sm transition-opacity ${getCellColor(count, data.maxCount)} hover:opacity-80`}
                          onMouseEnter={(e) => {
                            const rect =
                              e.currentTarget.getBoundingClientRect();
                            const parentRect =
                              e.currentTarget
                                .closest("[data-heatmap]")
                                ?.getBoundingClientRect() ?? rect;
                            setTooltip({
                              lab: row.labName,
                              date: d,
                              count,
                              x: rect.left - parentRect.left + rect.width / 2,
                              y: rect.top - parentRect.top - 4,
                            });
                          }}
                          onMouseLeave={() => setTooltip(null)}
                        >
                          {count > 0 && (
                            <span className="text-[8px] font-medium text-white mix-blend-difference">
                              {count}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="w-[50px] shrink-0 text-right">
                    <Badge variant="secondary" className="text-[9px]">
                      {row.totalCases}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>

            {/* Legend */}
            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Less</span>
                <div className="h-3 w-3 rounded-sm bg-muted/40" />
                <div className="h-3 w-3 rounded-sm bg-emerald-200 dark:bg-emerald-900/60" />
                <div className="h-3 w-3 rounded-sm bg-emerald-300 dark:bg-emerald-700/70" />
                <div className="h-3 w-3 rounded-sm bg-emerald-400 dark:bg-emerald-600/80" />
                <div className="h-3 w-3 rounded-sm bg-emerald-500 dark:bg-emerald-500" />
                <div className="h-3 w-3 rounded-sm bg-emerald-600 dark:bg-emerald-400" />
                <span className="text-[10px] text-muted-foreground">More</span>
              </div>
              <span className="text-[10px] text-muted-foreground">
                {data.rows.length} labs shown
              </span>
            </div>
          </div>
        </div>

        {/* Tooltip */}
        {tooltip && (
          <div
            data-heatmap
            className="pointer-events-none absolute z-50 rounded-md border bg-card px-2.5 py-1.5 shadow-md"
            style={{
              left: tooltip.x,
              top: tooltip.y,
              transform: "translate(-50%, -100%)",
            }}
          >
            <p className="text-[11px] font-medium">{tooltip.lab}</p>
            <p className="text-[10px] text-muted-foreground">
              {tooltip.date} &middot;{" "}
              {tooltip.count === 0
                ? "No orders"
                : `${tooltip.count} case${tooltip.count > 1 ? "s" : ""}`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
