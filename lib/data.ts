import users from "../data/users.json";

// A denormalized incoming-case row as consumed by the analytics functions below.
// Labs/doctors/product-category are folded onto each row by the Supabase fetch
// (`@/lib/cases`) so these functions stay pure transformations over an array and
// carry no data source of their own.
export interface CaseRow {
  orderDate: string;
  amount: number;
  status: string | null;
  labId: number | null;
  labName: string;
  doctorId: number | null;
  doctorName: string;
  patientId: number | null;
  category: string;
}

export type User = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "operator" | "viewer";
  status: "active" | "inactive";
  lastLoginAt: string;
  createdAt: string;
};

export function getUsers(): User[] {
  return (users as User[]).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

// Upload-history types/reads live in `@/lib/uploads` (server-only). They were moved
// out of this file so `lib/data.ts` stays client-safe — `app/(dashboard)/page.tsx`
// is a client component that imports the analytics functions below, and pulling in
// the server Supabase client (`next/headers`) here breaks the client bundle.

export type TimeGranularity = "daily" | "weekly" | "monthly";

function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const dayOfWeek = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((dayOfWeek + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function getMonthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

function getPeriodKey(dateStr: string, granularity: TimeGranularity): string {
  if (granularity === "daily") return dateStr;
  if (granularity === "weekly") return getWeekKey(dateStr);
  return getMonthKey(dateStr);
}

function formatLabel(key: string, granularity: TimeGranularity): string {
  if (granularity === "daily") {
    const d = new Date(key + "T00:00:00");
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }
  if (granularity === "weekly") {
    const d = new Date(key + "T00:00:00");
    return `W${d.getDate()}/${d.getMonth() + 1}`;
  }
  return key;
}

export interface TimeSeriesPoint {
  period: string;
  label: string;
  revenue: number;
  cases: number;
  uniqueLabs: number;
  uniqueDoctors: number;
  uniquePatients: number;
  shipped: number;
  inProduction: number;
  hold: number;
}

export function getTimeSeries(
  cases: CaseRow[],
  granularity: TimeGranularity,
): TimeSeriesPoint[] {
  const map = new Map<
    string,
    {
      revenue: number;
      cases: number;
      labs: Set<number | null>;
      doctors: Set<number | null>;
      patients: Set<number | null>;
      shipped: number;
      inProduction: number;
      hold: number;
    }
  >();

  for (const c of cases) {
    const key = getPeriodKey(c.orderDate, granularity);
    if (!map.has(key)) {
      map.set(key, {
        revenue: 0,
        cases: 0,
        labs: new Set(),
        doctors: new Set(),
        patients: new Set(),
        shipped: 0,
        inProduction: 0,
        hold: 0,
      });
    }
    const entry = map.get(key)!;
    entry.revenue += c.amount;
    entry.cases += 1;
    entry.labs.add(c.labId);
    entry.doctors.add(c.doctorId);
    entry.patients.add(c.patientId);
    if (c.status === "Shipped") entry.shipped += 1;
    else if (c.status === "In Production") entry.inProduction += 1;
    else entry.hold += 1;
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      period: key,
      label: formatLabel(key, granularity),
      revenue: Math.round(v.revenue * 100) / 100,
      cases: v.cases,
      uniqueLabs: v.labs.size,
      uniqueDoctors: v.doctors.size,
      uniquePatients: v.patients.size,
      shipped: v.shipped,
      inProduction: v.inProduction,
      hold: v.hold,
    }));
}

export interface CategoryBreakdown {
  category: string;
  count: number;
  revenue: number;
}

export function getCategoryBreakdown(cases: CaseRow[]): CategoryBreakdown[] {
  const map = new Map<string, { count: number; revenue: number }>();
  for (const c of cases) {
    const cat = c.category || "Unknown";
    if (!map.has(cat)) map.set(cat, { count: 0, revenue: 0 });
    const entry = map.get(cat)!;
    entry.count += 1;
    entry.revenue += c.amount;
  }
  return Array.from(map.entries())
    .map(([category, v]) => ({
      category,
      count: v.count,
      revenue: Math.round(v.revenue * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count);
}

export interface TopEntity {
  name: string;
  count: number;
  revenue: number;
}

export function getTopLabs(cases: CaseRow[], limit = 10): TopEntity[] {
  const map = new Map<
    number | null,
    { name: string; count: number; revenue: number }
  >();
  for (const c of cases) {
    if (!map.has(c.labId))
      map.set(c.labId, {
        name: c.labName || `Lab #${c.labId}`,
        count: 0,
        revenue: 0,
      });
    const entry = map.get(c.labId)!;
    entry.count += 1;
    entry.revenue += c.amount;
  }
  return Array.from(map.values())
    .map((v) => ({
      name: v.name,
      count: v.count,
      revenue: Math.round(v.revenue * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function getTopDoctors(cases: CaseRow[], limit = 10): TopEntity[] {
  const map = new Map<
    number | null,
    { name: string; count: number; revenue: number }
  >();
  for (const c of cases) {
    if (!map.has(c.doctorId))
      map.set(c.doctorId, {
        name: c.doctorName || `Doctor #${c.doctorId}`,
        count: 0,
        revenue: 0,
      });
    const entry = map.get(c.doctorId)!;
    entry.count += 1;
    entry.revenue += c.amount;
  }
  return Array.from(map.values())
    .map((v) => ({
      name: v.name,
      count: v.count,
      revenue: Math.round(v.revenue * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface ClientChange extends TopEntity {
  period: string;
}

export function getClientChanges(cases: CaseRow[], limit = 20) {
  const dates = cases.map((c) => c.orderDate).sort();
  const midpoint = dates[Math.floor(dates.length / 2)];

  const week1 = cases.filter((c) => c.orderDate < midpoint);
  const week2 = cases.filter((c) => c.orderDate >= midpoint);

  const week1Range = `${dates[0]} — ${week1.map((c) => c.orderDate).sort().pop()}`;
  const week2Range = `${week2.map((c) => c.orderDate).sort()[0]} — ${dates[dates.length - 1]}`;

  function buildLabMap(rows: CaseRow[]) {
    const map = new Map<
      number | null,
      { name: string; count: number; revenue: number }
    >();
    for (const c of rows) {
      if (!map.has(c.labId))
        map.set(c.labId, {
          name: c.labName || `Lab #${c.labId}`,
          count: 0,
          revenue: 0,
        });
      const entry = map.get(c.labId)!;
      entry.count += 1;
      entry.revenue += c.amount;
    }
    return map;
  }

  const w1Labs = buildLabMap(week1);
  const w2Labs = buildLabMap(week2);

  const newClients: ClientChange[] = [];
  for (const [id, v] of w2Labs) {
    if (!w1Labs.has(id)) {
      newClients.push({
        name: v.name,
        count: v.count,
        revenue: Math.round(v.revenue * 100) / 100,
        period: week2Range,
      });
    }
  }
  newClients.sort((a, b) => b.count - a.count);

  const churnedClients: ClientChange[] = [];
  for (const [id, v] of w1Labs) {
    if (!w2Labs.has(id)) {
      churnedClients.push({
        name: v.name,
        count: v.count,
        revenue: Math.round(v.revenue * 100) / 100,
        period: week1Range,
      });
    }
  }
  churnedClients.sort((a, b) => b.count - a.count);

  return {
    newClients: newClients.slice(0, limit),
    churnedClients: churnedClients.slice(0, limit),
    week1Range,
    week2Range,
  };
}

export type HeatmapSort = "last-active" | "total-cases" | "name";

export interface HeatmapRow {
  labId: number | null;
  labName: string;
  totalCases: number;
  lastActiveDate: string;
  firstActiveDate: string;
  cells: Record<string, number>;
}

export interface HeatmapData {
  dates: string[];
  rows: HeatmapRow[];
  maxCount: number;
}

export function getClientHeatmap(
  cases: CaseRow[],
  limit = 40,
  sort: HeatmapSort = "last-active",
  dateRange?: { from: string; to: string },
): HeatmapData {
  const filtered = dateRange
    ? cases.filter((c) => c.orderDate >= dateRange.from && c.orderDate <= dateRange.to)
    : cases;

  const dates = Array.from(new Set(filtered.map((c) => c.orderDate))).sort();

  const labMap = new Map<
    number | null,
    {
      name: string;
      totalCases: number;
      lastActive: string;
      firstActive: string;
      cells: Record<string, number>;
    }
  >();

  for (const c of filtered) {
    if (!labMap.has(c.labId)) {
      labMap.set(c.labId, {
        name: c.labName || `Lab #${c.labId}`,
        totalCases: 0,
        lastActive: c.orderDate,
        firstActive: c.orderDate,
        cells: {},
      });
    }
    const entry = labMap.get(c.labId)!;
    entry.totalCases += 1;
    if (c.orderDate > entry.lastActive) entry.lastActive = c.orderDate;
    if (c.orderDate < entry.firstActive) entry.firstActive = c.orderDate;
    entry.cells[c.orderDate] = (entry.cells[c.orderDate] ?? 0) + 1;
  }

  let rows: HeatmapRow[] = Array.from(labMap.entries()).map(([id, v]) => ({
    labId: id,
    labName: v.name,
    totalCases: v.totalCases,
    lastActiveDate: v.lastActive,
    firstActiveDate: v.firstActive,
    cells: v.cells,
  }));

  if (sort === "last-active") {
    rows.sort((a, b) => a.lastActiveDate.localeCompare(b.lastActiveDate));
  } else if (sort === "total-cases") {
    rows.sort((a, b) => b.totalCases - a.totalCases);
  } else {
    rows.sort((a, b) => a.labName.localeCompare(b.labName));
  }

  rows = rows.slice(0, limit);

  let maxCount = 0;
  for (const r of rows) {
    for (const d of dates) {
      const v = r.cells[d] ?? 0;
      if (v > maxCount) maxCount = v;
    }
  }

  return { dates, rows, maxCount };
}

export function getSummary(cases: CaseRow[]) {
  const totalRevenue = cases.reduce((sum, c) => sum + c.amount, 0);
  const totalCases = cases.length;
  const uniqueLabCount = new Set(cases.map((c) => c.labId)).size;
  const uniqueDoctorCount = new Set(cases.map((c) => c.doctorId)).size;
  const uniquePatientCount = new Set(cases.map((c) => c.patientId)).size;
  const shipped = cases.filter((c) => c.status === "Shipped").length;
  const inProduction = cases.filter(
    (c) => c.status === "In Production",
  ).length;
  const hold = cases.filter((c) => c.status === "Hold").length;

  const dates = cases.map((c) => c.orderDate).sort();
  const dateRange = { from: dates[0] ?? "", to: dates[dates.length - 1] ?? "" };

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalCases,
    uniqueLabCount,
    uniqueDoctorCount,
    uniquePatientCount,
    shipped,
    inProduction,
    hold,
    dateRange,
  };
}
