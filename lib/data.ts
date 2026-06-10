import users from "../data/users.json"

// Types and pure helpers for the dashboard aggregates. Since the
// get_dashboard_overview RPC migration, all heavy aggregation happens in
// Postgres — this module only types the RPC payload and does the cheap,
// interactivity-driven shaping (period labels, heatmap sort/limit) that has
// to run client-side. It must stay client-safe (no server-only imports).

export type User = {
  id: string
  name: string
  email: string
  role: "admin" | "operator" | "viewer"
  status: "active" | "inactive"
  lastLoginAt: string
  createdAt: string
}

export function getUsers(): User[] {
  return (users as User[]).sort((a, b) => a.name.localeCompare(b.name))
}

export type TimeGranularity = "daily" | "weekly" | "monthly"

export interface TimeSeriesPoint {
  period: string
  label: string
  revenue: number
  cases: number
  uniqueLabs: number
  uniqueDoctors: number
  uniquePatients: number
  shipped: number
  inProduction: number
  hold: number
}

// A time-series point as returned by the RPC — labels are a presentation
// concern, attached by withPeriodLabels.
export type RpcTimeSeriesPoint = Omit<TimeSeriesPoint, "label">

function formatLabel(key: string, granularity: TimeGranularity): string {
  if (granularity === "daily") {
    const d = new Date(key + "T00:00:00")
    return `${d.getDate()}/${d.getMonth() + 1}`
  }
  if (granularity === "weekly") {
    const d = new Date(key + "T00:00:00")
    return `W${d.getDate()}/${d.getMonth() + 1}`
  }
  return key
}

export function withPeriodLabels(
  points: RpcTimeSeriesPoint[],
  granularity: TimeGranularity
): TimeSeriesPoint[] {
  return points.map((p) => ({
    ...p,
    label: formatLabel(p.period, granularity),
  }))
}

export interface DashboardSummary {
  totalRevenue: number
  totalCases: number
  uniqueLabCount: number
  uniqueDoctorCount: number
  uniquePatientCount: number
  shipped: number
  inProduction: number
  hold: number
}

export interface CategoryBreakdown {
  category: string
  count: number
  revenue: number
}

export interface TopEntity {
  name: string
  count: number
  revenue: number
}

export interface ClientChange extends TopEntity {
  period: string
}

// Per-lab day→count map from the RPC; the heatmap grid is rebuilt from these
// on the client so the sort/limit selects stay interactive without a round trip.
export interface HeatmapLab {
  labId: number | null
  labName: string
  cells: Record<string, number>
}

export interface DashboardOverviewData {
  summary: DashboardSummary
  series: Record<TimeGranularity, TimeSeriesPoint[]>
  categories: CategoryBreakdown[]
  topLabs: TopEntity[]
  topDoctors: TopEntity[]
  heatmapLabs: HeatmapLab[]
}

export type HeatmapSort = "last-active" | "total-cases" | "name"

export interface HeatmapRow {
  labId: number | null
  labName: string
  totalCases: number
  lastActiveDate: string
  firstActiveDate: string
  cells: Record<string, number>
}

export interface HeatmapData {
  dates: string[]
  rows: HeatmapRow[]
  maxCount: number
}

export function buildHeatmap(
  labs: HeatmapLab[],
  limit = 40,
  sort: HeatmapSort = "last-active"
): HeatmapData {
  const dateSet = new Set<string>()

  let rows: HeatmapRow[] = labs.map((lab) => {
    let totalCases = 0
    let lastActive = ""
    let firstActive = ""
    for (const [date, count] of Object.entries(lab.cells)) {
      dateSet.add(date)
      totalCases += count
      if (!lastActive || date > lastActive) lastActive = date
      if (!firstActive || date < firstActive) firstActive = date
    }
    return {
      labId: lab.labId,
      labName: lab.labName,
      totalCases,
      lastActiveDate: lastActive,
      firstActiveDate: firstActive,
      cells: lab.cells,
    }
  })

  const dates = Array.from(dateSet).sort()

  if (sort === "last-active") {
    rows.sort((a, b) => a.lastActiveDate.localeCompare(b.lastActiveDate))
  } else if (sort === "total-cases") {
    rows.sort((a, b) => b.totalCases - a.totalCases)
  } else {
    rows.sort((a, b) => a.labName.localeCompare(b.labName))
  }

  rows = rows.slice(0, limit)

  let maxCount = 0
  for (const r of rows) {
    for (const d of dates) {
      const v = r.cells[d] ?? 0
      if (v > maxCount) maxCount = v
    }
  }

  return { dates, rows, maxCount }
}
