"use client"

import { memo, useState } from "react"
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
  type TooltipContentProps,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartLegend, type ChartSeries } from "@/components/chart-legend"
import { ChartScrollContainer } from "@/components/chart-scroll-container"
import type { TimeSeriesPoint } from "@/lib/data"

interface IncomingCaseChartProps {
  data: TimeSeriesPoint[]
}

// "Account (Lab)" is the distinct-lab count and "Redo Case" is the redo count —
// both render as grouped bars on the left axis alongside the "Case" line.
// "Amount (USD)" is revenue and lives on the right axis because its scale
// (hundreds of thousands) dwarfs the counts.
const ACCOUNT: ChartSeries = {
  key: "uniqueLabs",
  name: "Account (Lab)",
  color: "#3b82f6",
}
const REDO: ChartSeries = { key: "redo", name: "Redo Case", color: "#f59e0b" }
const CASE: ChartSeries = { key: "cases", name: "Case", color: "#10b981" }
const AMOUNT: ChartSeries = {
  key: "revenue",
  name: "Amount (USD)",
  color: "#ef4444",
}
const SERIES: ChartSeries[] = [ACCOUNT, REDO, CASE, AMOUNT]

// Compact form for the right-axis ticks (gridline references only).
function formatCurrencyAxis(
  value: string | number | boolean | null | undefined
): string {
  const n = Number(value)
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n}`
}

// Full, unrounded value for data labels and the tooltip.
function formatCurrencyFull(
  value: string | number | boolean | null | undefined
): string {
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
}

function hideZero(value: string | number | boolean | null | undefined): string {
  return value ? String(value) : ""
}

function IncomingCaseTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs text-foreground shadow-sm">
      <p className="mb-1 font-medium">{String(label)}</p>
      {payload.map((entry) => (
        <p key={String(entry.dataKey)} style={{ color: entry.color }}>
          {entry.name} :{" "}
          {entry.dataKey === AMOUNT.key
            ? formatCurrencyFull(Number(entry.value))
            : entry.value}
        </p>
      ))}
    </div>
  )
}

export const IncomingCaseChart = memo(function IncomingCaseChart({
  data,
}: IncomingCaseChartProps) {
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
        <CardTitle className="text-sm font-medium">
          Incoming Case Report
        </CardTitle>
        <ChartLegend series={SERIES} hidden={hidden} onToggle={toggle} />
      </CardHeader>
      <CardContent className="pt-0">
        <ChartScrollContainer data={data}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={data}
              margin={{ top: 20, right: 10, left: 0, bottom: 0 }}
              barGap={2}
              barCategoryGap="40%"
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
                yAxisId="left"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={["auto", "auto"]}
                tickFormatter={formatCurrencyAxis}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={50}
              />
              <Tooltip
                cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }}
                content={IncomingCaseTooltip}
              />
              <Bar
                yAxisId="left"
                dataKey={ACCOUNT.key}
                name={ACCOUNT.name}
                fill={ACCOUNT.color}
                radius={[3, 3, 0, 0]}
                hide={hidden.has(ACCOUNT.key)}
              >
                <LabelList
                  dataKey={ACCOUNT.key}
                  position="top"
                  offset={6}
                  fontSize={10}
                  fill={ACCOUNT.color}
                  formatter={hideZero}
                />
              </Bar>
              <Bar
                yAxisId="left"
                dataKey={REDO.key}
                name={REDO.name}
                fill={REDO.color}
                radius={[3, 3, 0, 0]}
                hide={hidden.has(REDO.key)}
              >
                <LabelList
                  dataKey={REDO.key}
                  position="top"
                  offset={6}
                  fontSize={10}
                  fill={REDO.color}
                  formatter={hideZero}
                />
              </Bar>
              <Line
                yAxisId="left"
                type="monotone"
                dataKey={CASE.key}
                name={CASE.name}
                stroke={CASE.color}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                hide={hidden.has(CASE.key)}
              >
                <LabelList
                  dataKey={CASE.key}
                  position="top"
                  offset={8}
                  fontSize={10}
                  fill={CASE.color}
                />
              </Line>
              <Line
                yAxisId="right"
                type="monotone"
                dataKey={AMOUNT.key}
                name={AMOUNT.name}
                stroke={AMOUNT.color}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                hide={hidden.has(AMOUNT.key)}
              >
                <LabelList
                  dataKey={AMOUNT.key}
                  position="bottom"
                  offset={8}
                  fontSize={10}
                  fill={AMOUNT.color}
                  formatter={formatCurrencyFull}
                />
              </Line>
            </ComposedChart>
          </ResponsiveContainer>
        </ChartScrollContainer>
      </CardContent>
    </Card>
  )
})
