"use client"

import { memo, useState, useEffect } from "react"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ChartLegend, type ChartSeries } from "@/components/chart-legend"
import type { TimeSeriesPoint } from "@/lib/data"

interface VolumeChartProps {
  data: TimeSeriesPoint[]
}

// Minimum horizontal space per data point. With daily granularity over a few months
// this pushes the chart past the card width so it scrolls; for weekly/monthly the
// computed min-width stays under the card and the chart just fills it (no scroll).
const MIN_PX_PER_POINT = 44

const SERIES: ChartSeries[] = [
  { key: "shipped", name: "Shipped", color: "#10b981" },
  { key: "inProduction", name: "In Production", color: "#3b82f6" },
  { key: "hold", name: "On Hold", color: "#ef4444" },
]

function hideZero(value: string | number | boolean | null | undefined): string {
  return value ? String(value) : ""
}

export const VolumeChart = memo(function VolumeChart({
  data,
}: VolumeChartProps) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
        <CardTitle className="text-sm font-medium">Volume Trend</CardTitle>
        <ChartLegend series={SERIES} hidden={hidden} onToggle={toggle} />
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[280px] overflow-x-auto">
          {!mounted ? (
            <Skeleton className="size-full" />
          ) : (
            <div
              className="h-full"
              style={{ minWidth: `${data.length * MIN_PX_PER_POINT}px` }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data}
                  margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={35}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "8px",
                      border: "1px solid var(--border)",
                      background: "var(--card)",
                      color: "var(--foreground)",
                      fontSize: 12,
                    }}
                  />
                  {SERIES.map((s) => (
                    <Bar
                      key={s.key}
                      dataKey={s.key}
                      name={s.name}
                      fill={s.color}
                      radius={[3, 3, 0, 0]}
                      stackId="status"
                      hide={hidden.has(s.key)}
                    >
                      <LabelList
                        dataKey={s.key}
                        position="center"
                        fontSize={10}
                        fill="#fff"
                        formatter={hideZero}
                      />
                    </Bar>
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
})
