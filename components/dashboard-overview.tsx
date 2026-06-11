"use client"

import { useState, useTransition } from "react"
import { format, parseISO } from "date-fns"
import type { DateRange } from "react-day-picker"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DateRangePicker } from "@/components/date-range-picker"
import { QuickRangeFilter } from "@/components/quick-range-filter"
import { KpiCards } from "@/components/kpi-cards"
import { IncomingCaseChart } from "@/components/incoming-case-chart"
import { RevenueChart } from "@/components/revenue-chart"
import { CustomerChart } from "@/components/customer-chart"
import { VolumeChart } from "@/components/volume-chart"
import { CategoryChart } from "@/components/category-chart"
import { TopTable } from "@/components/top-table"
import { ClientHeatmap } from "@/components/client-heatmap"
import { cn } from "@/lib/utils"
import type { DashboardOverviewData, TimeGranularity } from "@/lib/data"

export function DashboardOverview({
  data,
  from,
  to,
}: {
  data: DashboardOverviewData
  from: string
  to: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const [granularity, setGranularity] = useState<TimeGranularity>("daily")

  // Local state mirrors the URL-driven range so an in-progress selection (first
  // click of a range) renders immediately; once both ends are picked we write to
  // the URL, which re-runs the server query and feeds new `from`/`to` back in.
  // Reset during render (not in an effect) when the URL-derived range changes.
  const [range, setRange] = useState<DateRange | undefined>({
    from: parseISO(from),
    to: parseISO(to),
  })
  const [syncedKey, setSyncedKey] = useState(`${from}|${to}`)
  if (syncedKey !== `${from}|${to}`) {
    setSyncedKey(`${from}|${to}`)
    setRange({ from: parseISO(from), to: parseISO(to) })
  }

  function handleRangeChange(next: DateRange | undefined) {
    setRange(next)
    // Wait for a complete range before navigating; ignore the partial first click.
    if (next?.from && !next?.to) return

    const params = new URLSearchParams(searchParams.toString())
    if (next?.from && next?.to) {
      params.set("from", format(next.from, "yyyy-MM-dd"))
      params.set("to", format(next.to, "yyyy-MM-dd"))
    } else {
      params.delete("from")
      params.delete("to")
    }
    const qs = params.toString()
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    })
  }

  // All aggregates arrive precomputed from the server; the granularity tabs
  // just pick one of the three precomputed series.
  const { summary } = data
  const timeSeries = data.series[granularity]

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Operations Overview</h2>
        <div className="flex items-center gap-2">
          <QuickRangeFilter onSelect={handleRangeChange} />
          <DateRangePicker value={range} onChange={handleRangeChange} />
        </div>
      </div>

      <div
        className={cn(
          "flex flex-col gap-4 transition-opacity",
          isPending && "pointer-events-none opacity-60"
        )}
      >
        <KpiCards
          totalRevenue={summary.totalRevenue}
          totalCases={summary.totalCases}
          uniqueLabCount={summary.uniqueLabCount}
          uniqueDoctorCount={summary.uniqueDoctorCount}
          shipped={summary.shipped}
          inProduction={summary.inProduction}
          hold={summary.hold}
        />

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Trends Over Time</h2>
          <Tabs
            value={granularity}
            onValueChange={(v) => setGranularity(v as TimeGranularity)}
          >
            <TabsList className="h-8">
              <TabsTrigger value="daily" className="cursor-pointer text-xs">
                Daily
              </TabsTrigger>
              <TabsTrigger value="weekly" className="cursor-pointer text-xs">
                Weekly
              </TabsTrigger>
              <TabsTrigger value="monthly" className="cursor-pointer text-xs">
                Monthly
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <IncomingCaseChart data={timeSeries} />

        <ClientHeatmap labs={data.heatmapLabs} />

        <div className="grid gap-4 lg:grid-cols-2">
          <RevenueChart data={timeSeries} />
          <CustomerChart data={timeSeries} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <VolumeChart data={timeSeries} />
          <CategoryChart data={data.categories} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <TopTable title="Top 10 Labs" data={data.topLabs} />
          <TopTable title="Top 10 Doctors" data={data.topDoctors} />
        </div>
      </div>
    </>
  )
}
