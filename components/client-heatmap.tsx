"use client"

import { memo, useCallback, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import {
  buildHeatmap,
  type HeatmapData,
  type HeatmapLab,
  type HeatmapSort,
} from "@/lib/data"

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00")
  return `${d.getDate()}/${d.getMonth() + 1}`
}

function getDayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00")
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]
}

// Fixed pixel width per day column so the grid scrolls at a readable size instead of
// crushing ~90 days into the card width. Wide enough to fit a "DD/M" header label.
const CELL_W = 28

function getCellColor(count: number, max: number): string {
  if (count === 0) return "bg-muted/40"
  const ratio = count / max
  if (ratio <= 0.15) return "bg-emerald-200 dark:bg-emerald-900/60"
  if (ratio <= 0.35) return "bg-emerald-300 dark:bg-emerald-700/70"
  if (ratio <= 0.6) return "bg-emerald-400 dark:bg-emerald-600/80"
  if (ratio <= 0.8) return "bg-emerald-500 dark:bg-emerald-500"
  return "bg-emerald-600 dark:bg-emerald-400"
}

interface TooltipState {
  lab: string
  date: string
  count: number
  x: number
  y: number
}

// The grid is by far the largest DOM subtree on the page (labs × days cells).
// It's memoized so the hover tooltip — state held by the parent — repaints
// without re-rendering every cell.
const HeatmapGrid = memo(function HeatmapGrid({
  data,
  onCellEnter,
  onCellLeave,
}: {
  data: HeatmapData
  onCellEnter: (tooltip: TooltipState) => void
  onCellLeave: () => void
}) {
  return (
    <div className="max-h-[600px] overflow-auto">
      <div className="w-max">
        {/* Date header row — sticky on top; corners pinned to both edges */}
        <div className="sticky top-0 z-30 mb-1 flex bg-card">
          <div className="sticky left-0 z-40 w-[160px] shrink-0 border-r border-border/50 bg-card" />
          <div className="flex gap-px">
            {data.dates.map((d) => (
              <div
                key={d}
                className="flex shrink-0 flex-col items-center"
                style={{ width: CELL_W }}
              >
                <span className="text-[9px] leading-tight text-muted-foreground">
                  {getDayOfWeek(d)}
                </span>
                <span className="text-[10px] leading-tight font-medium">
                  {formatDateLabel(d)}
                </span>
              </div>
            ))}
          </div>
          <div className="sticky right-0 z-40 w-[50px] shrink-0 border-l border-border/50 bg-card" />
        </div>

        {/* Heatmap rows */}
        {data.rows.map((row) => (
          <div
            key={row.labId ?? "unknown"}
            className="group flex items-center py-px"
          >
            <div
              className="sticky left-0 z-20 w-[160px] shrink-0 truncate border-r border-border/50 bg-card pr-2 text-[11px] leading-tight"
              title={row.labName}
            >
              {row.labName}
            </div>
            <div className="flex gap-px">
              {data.dates.map((d) => {
                const count = row.cells[d] ?? 0
                return (
                  <div
                    key={d}
                    className={`flex aspect-square shrink-0 cursor-pointer items-center justify-center rounded-sm transition-opacity ${getCellColor(count, data.maxCount)} hover:opacity-80`}
                    style={{ width: CELL_W }}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      const parentRect =
                        e.currentTarget
                          .closest("[data-heatmap]")
                          ?.getBoundingClientRect() ?? rect
                      onCellEnter({
                        lab: row.labName,
                        date: d,
                        count,
                        x: rect.left - parentRect.left + rect.width / 2,
                        y: rect.top - parentRect.top - 4,
                      })
                    }}
                    onMouseLeave={onCellLeave}
                  >
                    {count > 0 && (
                      <span className="text-[9px] font-medium text-white mix-blend-difference">
                        {count}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="sticky right-0 z-20 w-[50px] shrink-0 border-l border-border/50 bg-card pl-1 text-right">
              <Badge variant="secondary" className="text-[9px]">
                {row.totalCases}
              </Badge>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})

// Tooltip state lives here, one level below the card chrome, so a cell hover
// re-renders only the (bailed-out) memoized grid and the tooltip overlay —
// not the header/selects/legend around it.
function HeatmapBody({ data }: { data: HeatmapData }) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const handleCellEnter = useCallback(
    (next: TooltipState) => setTooltip(next),
    []
  )
  const handleCellLeave = useCallback(() => setTooltip(null), [])

  return (
    <>
      <HeatmapGrid
        data={data}
        onCellEnter={handleCellEnter}
        onCellLeave={handleCellLeave}
      />

      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-50 rounded-md border bg-card px-2.5 py-1.5 whitespace-nowrap shadow-md"
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
    </>
  )
}

export function ClientHeatmap({ labs }: { labs: HeatmapLab[] }) {
  const [sort, setSort] = useState<HeatmapSort>("last-active")
  const [limit, setLimit] = useState(40)

  const data = useMemo(
    () => buildHeatmap(labs, limit, sort),
    [labs, limit, sort]
  )

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
      <CardContent className="relative pt-0" data-heatmap>
        <HeatmapBody data={data} />

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
      </CardContent>
    </Card>
  )
}
