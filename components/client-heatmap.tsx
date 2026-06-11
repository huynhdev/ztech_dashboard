"use client"

import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
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
  type HeatmapRow,
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
// Row height = aspect-square cell (CELL_W) + py-px (1px top + bottom). Must stay in
// sync with the row classes below — the virtualizer positions rows by this constant.
const ROW_H = CELL_W + 2

function activeRange(row: HeatmapRow): string {
  return row.firstActiveDate === row.lastActiveDate
    ? row.lastActiveDate
    : `${row.firstActiveDate} → ${row.lastActiveDate}`
}

const amountFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})

// Day cells are CELL_W wide — "$1,234.56" can't fit, so footer amounts render
// compact ("5.2K"); the hover tooltip carries the exact value.
function formatCellAmount(v: number): string {
  return v >= 1000 ? compactFormatter.format(v) : String(Math.round(v))
}

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
  title: string
  detail: string
  x: number
  y: number
  // Totals sit at the card's right edge; right-aligning keeps the tooltip inside it.
  align: "center" | "right"
}

function tooltipAnchor(
  e: MouseEvent<HTMLElement>,
  align: TooltipState["align"]
): Pick<TooltipState, "x" | "y" | "align"> {
  const rect = e.currentTarget.getBoundingClientRect()
  const parentRect =
    e.currentTarget.closest("[data-heatmap]")?.getBoundingClientRect() ?? rect
  return {
    x:
      (align === "center" ? rect.left + rect.width / 2 : rect.right) -
      parentRect.left,
    y: rect.top - parentRect.top - 4,
    align,
  }
}

// The grid is by far the largest DOM subtree on the page (labs × days cells).
// Rows are virtualized: only the ~20 visible rows (plus overscan) are mounted,
// so "All labs" doesn't put labs × days cells in the DOM at once. It's also
// memoized so the hover tooltip — state held by the parent — repaints without
// re-rendering the mounted cells.
const HeatmapGrid = memo(function HeatmapGrid({
  data,
  onCellEnter,
  onCellLeave,
}: {
  data: HeatmapData
  onCellEnter: (tooltip: TooltipState) => void
  onCellLeave: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: data.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  })

  const grandCases = data.rows.reduce((sum, r) => sum + r.totalCases, 0)
  const grandAmount = data.rows.reduce((sum, r) => sum + r.totalAmount, 0)
  const grandRedo = data.rows.reduce((sum, r) => sum + r.totalRedo, 0)

  return (
    <div ref={scrollRef} className="max-h-[600px] overflow-auto">
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
          <div className="sticky right-0 z-40 flex w-[176px] shrink-0 items-end border-l border-border/50 bg-card pb-px">
            <span className="w-[44px] text-right text-[9px] leading-tight text-muted-foreground">
              Cases
            </span>
            <span className="w-[36px] text-right text-[9px] leading-tight text-muted-foreground">
              Redo
            </span>
            <span className="flex-1 pr-0.5 text-right text-[9px] leading-tight text-muted-foreground">
              Amount
            </span>
          </div>
        </div>

        {/* Heatmap rows — absolutely positioned inside a spacer sized to the
            full row count, so the scrollbar behaves as if every row existed */}
        <div
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = data.rows[virtualRow.index]
            return (
              <div
                key={row.labId ?? "unknown"}
                className="group absolute top-0 left-0 flex w-full items-center py-px"
                style={{
                  height: ROW_H,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div
                  className="sticky left-0 z-20 flex h-full w-[160px] shrink-0 items-center border-r border-border/50 bg-card pr-2 text-[11px] leading-tight"
                  title={row.labName}
                >
                  <span className="truncate">{row.labName}</span>
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
                          onCellEnter({
                            title: row.labName,
                            detail: `${d} · ${
                              count === 0
                                ? "No orders"
                                : `${count} case${count > 1 ? "s" : ""}`
                            }`,
                            ...tooltipAnchor(e, "center"),
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
                <div className="sticky right-0 z-20 flex h-full w-[176px] shrink-0 items-center border-l border-border/50 bg-card pl-1">
                  <div
                    className="w-[44px] text-right"
                    onMouseEnter={(e) =>
                      onCellEnter({
                        title: row.labName,
                        detail: `${row.totalCases} case${row.totalCases === 1 ? "" : "s"} · ${activeRange(row)}`,
                        ...tooltipAnchor(e, "right"),
                      })
                    }
                    onMouseLeave={onCellLeave}
                  >
                    <Badge variant="secondary" className="text-[9px]">
                      {row.totalCases}
                    </Badge>
                  </div>
                  <div
                    className={`w-[36px] text-right text-[10px] tabular-nums ${
                      row.totalRedo > 0
                        ? "font-medium text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground/50"
                    }`}
                    onMouseEnter={(e) =>
                      onCellEnter({
                        title: row.labName,
                        detail: `${row.totalRedo} redo case${row.totalRedo === 1 ? "" : "s"} · ${activeRange(row)}`,
                        ...tooltipAnchor(e, "right"),
                      })
                    }
                    onMouseLeave={onCellLeave}
                  >
                    {row.totalRedo}
                  </div>
                  <div
                    className="flex-1 pr-0.5 text-right text-[10px] text-muted-foreground tabular-nums"
                    onMouseEnter={(e) =>
                      onCellEnter({
                        title: row.labName,
                        detail: `${amountFormatter.format(row.totalAmount)} · ${activeRange(row)}`,
                        ...tooltipAnchor(e, "right"),
                      })
                    }
                    onMouseLeave={onCellLeave}
                  >
                    {amountFormatter.format(row.totalAmount)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer totals — pinned to the bottom edge of the scroll viewport */}
        <div className="sticky bottom-0 z-30 border-t border-border/50 bg-card">
          <div className="flex items-center py-px" style={{ height: ROW_H }}>
            <div className="sticky left-0 z-20 flex h-full w-[160px] shrink-0 items-center border-r border-border/50 bg-card pr-2 text-[9px] font-medium tracking-wide text-muted-foreground">
              TOTAL CASE/DAY
            </div>
            <div className="flex gap-px">
              {data.dates.map((d) => {
                const total = data.dailyCases[d] ?? 0
                return (
                  <div
                    key={d}
                    className="flex shrink-0 items-center justify-center"
                    style={{ width: CELL_W }}
                    onMouseEnter={(e) =>
                      onCellEnter({
                        title: "Total cases / day",
                        detail: `${d} · ${total} case${total === 1 ? "" : "s"}`,
                        ...tooltipAnchor(e, "center"),
                      })
                    }
                    onMouseLeave={onCellLeave}
                  >
                    <span
                      className={`text-[9px] tabular-nums ${
                        total > 0 ? "font-medium" : "text-muted-foreground/40"
                      }`}
                    >
                      {total}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="sticky right-0 z-20 flex h-full w-[176px] shrink-0 items-center border-l border-border/50 bg-card pl-1">
              <div className="w-[44px] text-right">
                <Badge variant="secondary" className="text-[9px]">
                  {grandCases}
                </Badge>
              </div>
              <div className="w-[36px]" />
              <div className="flex-1" />
            </div>
          </div>
          <div className="flex items-center py-px" style={{ height: ROW_H }}>
            <div className="sticky left-0 z-20 flex h-full w-[160px] shrink-0 items-center border-r border-border/50 bg-card pr-2 text-[9px] font-medium tracking-wide text-muted-foreground">
              TOTAL REDO CASE/DAY
            </div>
            <div className="flex gap-px">
              {data.dates.map((d) => {
                const total = data.dailyRedos[d] ?? 0
                return (
                  <div
                    key={d}
                    className="flex shrink-0 items-center justify-center"
                    style={{ width: CELL_W }}
                    onMouseEnter={(e) =>
                      onCellEnter({
                        title: "Total redo cases / day",
                        detail: `${d} · ${total} redo case${total === 1 ? "" : "s"}`,
                        ...tooltipAnchor(e, "center"),
                      })
                    }
                    onMouseLeave={onCellLeave}
                  >
                    <span
                      className={`text-[9px] tabular-nums ${
                        total > 0
                          ? "font-medium text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground/40"
                      }`}
                    >
                      {total}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="sticky right-0 z-20 flex h-full w-[176px] shrink-0 items-center border-l border-border/50 bg-card pl-1">
              <div className="w-[44px]" />
              <div className="w-[36px] text-right text-[10px] font-medium text-amber-600 tabular-nums dark:text-amber-400">
                {grandRedo}
              </div>
              <div className="flex-1" />
            </div>
          </div>
          <div className="flex items-center py-px" style={{ height: ROW_H }}>
            <div className="sticky left-0 z-20 flex h-full w-[160px] shrink-0 items-center border-r border-border/50 bg-card pr-2 text-[9px] font-medium tracking-wide text-muted-foreground">
              TOTAL AMOUNT/DAY
            </div>
            <div className="flex gap-px">
              {data.dates.map((d) => {
                const total = data.dailyAmounts[d] ?? 0
                return (
                  <div
                    key={d}
                    className="flex shrink-0 items-center justify-center"
                    style={{ width: CELL_W }}
                    onMouseEnter={(e) =>
                      onCellEnter({
                        title: "Total amount / day",
                        detail: `${d} · ${amountFormatter.format(total)}`,
                        ...tooltipAnchor(e, "center"),
                      })
                    }
                    onMouseLeave={onCellLeave}
                  >
                    <span
                      className={`text-[8px] tabular-nums ${
                        total > 0 ? "font-medium" : "text-muted-foreground/40"
                      }`}
                    >
                      {formatCellAmount(total)}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="sticky right-0 z-20 flex h-full w-[176px] shrink-0 items-center border-l border-border/50 bg-card pl-1">
              <div className="w-[44px]" />
              <div className="w-[36px]" />
              <div className="flex-1 pr-0.5 text-right text-[10px] font-medium tabular-nums">
                {amountFormatter.format(grandAmount)}
              </div>
            </div>
          </div>
        </div>
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
            transform:
              tooltip.align === "center"
                ? "translate(-50%, -100%)"
                : "translate(-100%, -100%)",
          }}
        >
          <p className="text-[11px] font-medium">{tooltip.title}</p>
          <p className="text-[10px] text-muted-foreground">{tooltip.detail}</p>
        </div>
      )}
    </>
  )
}

export function ClientHeatmap({ labs }: { labs: HeatmapLab[] }) {
  const [sort, setSort] = useState<HeatmapSort>("last-active")
  const [limit, setLimit] = useState<number | "all">("all")

  const data = useMemo(
    () => buildHeatmap(labs, limit === "all" ? labs.length : limit, sort),
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
              onValueChange={(v) => setLimit(v === "all" ? "all" : Number(v))}
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
                <SelectItem value="all" className="cursor-pointer text-xs">
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
