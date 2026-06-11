"use client"

import { memo } from "react"
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartScrollContainer } from "@/components/chart-scroll-container"
import type { TimeSeriesPoint } from "@/lib/data"

interface RevenueChartProps {
  data: TimeSeriesPoint[]
}

function formatCurrency(
  value: string | number | boolean | null | undefined
): string {
  const n = Number(value)
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n}`
}

function formatFullCurrency(
  value: string | number | boolean | null | undefined
): string {
  return `$${Number(value).toLocaleString()}`
}

// Memoized so parent state changes (date-picker selection, tooltip) don't
// re-render the chart; it only re-renders when `data` identity changes.
export const RevenueChart = memo(function RevenueChart({
  data,
}: RevenueChartProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Revenue Trend</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ChartScrollContainer data={data}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
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
                tickFormatter={formatCurrency}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={55}
              />
              <Tooltip
                formatter={(value) => [
                  formatFullCurrency(Number(value)),
                  "Revenue",
                ]}
                contentStyle={{
                  borderRadius: "8px",
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  color: "var(--foreground)",
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="#10b981"
                strokeWidth={2}
                fill="url(#revenueGrad)"
              >
                <LabelList
                  dataKey="revenue"
                  position="top"
                  offset={8}
                  fontSize={10}
                  fill="var(--foreground)"
                  formatter={formatFullCurrency}
                />
              </Area>
            </AreaChart>
          </ResponsiveContainer>
        </ChartScrollContainer>
      </CardContent>
    </Card>
  )
})
