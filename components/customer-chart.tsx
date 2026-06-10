"use client"

import { memo, useState, useEffect } from "react"
import {
  LineChart,
  Line,
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

interface CustomerChartProps {
  data: TimeSeriesPoint[]
}

// Minimum horizontal space per data point. With daily granularity over a few months
// this pushes the chart past the card width so it scrolls; for weekly/monthly the
// computed min-width stays under the card and the chart just fills it (no scroll).
const MIN_PX_PER_POINT = 44

const SERIES: ChartSeries[] = [
  { key: "uniqueLabs", name: "Labs", color: "#8b5cf6" },
  { key: "uniqueDoctors", name: "Doctors", color: "#f59e0b" },
  { key: "uniquePatients", name: "Patients", color: "#3b82f6" },
]

export const CustomerChart = memo(function CustomerChart({
  data,
}: CustomerChartProps) {
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
        <CardTitle className="text-sm font-medium">Customer Trend</CardTitle>
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
                <LineChart
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
                    <Line
                      key={s.key}
                      type="monotone"
                      dataKey={s.key}
                      name={s.name}
                      stroke={s.color}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                      hide={hidden.has(s.key)}
                    >
                      <LabelList
                        dataKey={s.key}
                        position="top"
                        offset={8}
                        fontSize={10}
                        fill={s.color}
                      />
                    </Line>
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
})
