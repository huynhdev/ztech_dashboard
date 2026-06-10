import { createClient } from "@/lib/supabase/server"
import {
  withPeriodLabels,
  type DashboardOverviewData,
  type RpcTimeSeriesPoint,
  type TimeGranularity,
} from "@/lib/data"

// Inclusive ISO (yyyy-MM-dd) bounds for the dashboard date filter. The page reads
// these from the URL searchParams so a filtered view is shareable/bookmarkable.
export type DateRangeFilter = { from: string; to: string }

type RpcPayload = Omit<DashboardOverviewData, "series"> & {
  series: Record<TimeGranularity, RpcTimeSeriesPoint[]>
}

// Server-only fetch of every aggregate the dashboard overview needs, computed
// in Postgres by the get_dashboard_overview RPC. One round trip regardless of
// row count, and the payload scales with days/labs in range rather than with
// the number of cases — previously all raw rows were fetched (1000-row pages,
// serially) and shipped to the client for aggregation.
export async function getDashboardOverview(
  range: DateRangeFilter
): Promise<DashboardOverviewData | null> {
  const supabase = await createClient()

  const { data, error } = await supabase.rpc("get_dashboard_overview", {
    p_from: range.from,
    p_to: range.to,
  })
  if (error) {
    console.error(
      "[getDashboardOverview] Supabase error:",
      error.message,
      error.code
    )
    return null
  }

  const payload = data as unknown as RpcPayload

  return {
    ...payload,
    series: {
      daily: withPeriodLabels(payload.series.daily, "daily"),
      weekly: withPeriodLabels(payload.series.weekly, "weekly"),
      monthly: withPeriodLabels(payload.series.monthly, "monthly"),
    },
  }
}

// Earliest and latest order_date across all cases, used to seed the default
// dashboard window (and to tell "no data at all" apart from "no data in range").
// Two indexed limit-1 lookups rather than scanning every row.
export async function getOrderDateBounds(): Promise<{
  min: string
  max: string
} | null> {
  const supabase = await createClient()
  const [{ data: earliest }, { data: latest }] = await Promise.all([
    supabase
      .from("incoming_cases")
      .select("order_date")
      .order("order_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("incoming_cases")
      .select("order_date")
      .order("order_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (!earliest || !latest) return null
  return { min: earliest.order_date, max: latest.order_date }
}
