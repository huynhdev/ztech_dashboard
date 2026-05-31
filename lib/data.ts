import incomingCases from "../data/incoming_cases.json";
import products from "../data/products.json";
import labs from "../data/labs.json";
import doctors from "../data/doctors.json";
import uploads from "../data/uploads.json";
import users from "../data/users.json";

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

export type Upload = {
  id: string;
  fileName: string;
  status: "completed" | "processing" | "failed";
  uploadedAt: string;
  uploader: string;
};

export function getUploads(): Upload[] {
  return (uploads as Upload[]).sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
  );
}

export type Case = (typeof incomingCases)[number];
export type Product = (typeof products)[number];
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

export function getTimeSeries(granularity: TimeGranularity): TimeSeriesPoint[] {
  const map = new Map<
    string,
    {
      revenue: number;
      cases: number;
      labs: Set<number>;
      doctors: Set<number>;
      patients: Set<number>;
      shipped: number;
      inProduction: number;
      hold: number;
    }
  >();

  for (const c of incomingCases) {
    const key = getPeriodKey(c.order_date, granularity);
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
    entry.labs.add(c.lab_id);
    entry.doctors.add(c.doctor_id);
    entry.patients.add(c.patient_id);
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

export function getCategoryBreakdown(): CategoryBreakdown[] {
  const map = new Map<string, { count: number; revenue: number }>();
  for (const c of incomingCases) {
    const product = products.find((p) => p.id === c.product_id);
    const cat = product?.category ?? "Unknown";
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

export function getTopLabs(limit = 10): TopEntity[] {
  const map = new Map<number, { count: number; revenue: number }>();
  for (const c of incomingCases) {
    if (!map.has(c.lab_id)) map.set(c.lab_id, { count: 0, revenue: 0 });
    const entry = map.get(c.lab_id)!;
    entry.count += 1;
    entry.revenue += c.amount;
  }
  return Array.from(map.entries())
    .map(([id, v]) => ({
      name: labs.find((l) => l.id === id)?.name ?? `Lab #${id}`,
      count: v.count,
      revenue: Math.round(v.revenue * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function getTopDoctors(limit = 10): TopEntity[] {
  const map = new Map<number, { count: number; revenue: number }>();
  for (const c of incomingCases) {
    if (!map.has(c.doctor_id))
      map.set(c.doctor_id, { count: 0, revenue: 0 });
    const entry = map.get(c.doctor_id)!;
    entry.count += 1;
    entry.revenue += c.amount;
  }
  return Array.from(map.entries())
    .map(([id, v]) => ({
      name: doctors.find((d) => d.id === id)?.name ?? `Doctor #${id}`,
      count: v.count,
      revenue: Math.round(v.revenue * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface ClientChange extends TopEntity {
  period: string;
}

function getClientChanges(limit = 20) {
  const dates = incomingCases.map((c) => c.order_date).sort();
  const midpoint = dates[Math.floor(dates.length / 2)];

  const week1 = incomingCases.filter((c) => c.order_date < midpoint);
  const week2 = incomingCases.filter((c) => c.order_date >= midpoint);

  const week1Range = `${dates[0]} — ${week1.map((c) => c.order_date).sort().pop()}`;
  const week2Range = `${week2.map((c) => c.order_date).sort()[0]} — ${dates[dates.length - 1]}`;

  function buildLabMap(cases: typeof incomingCases) {
    const map = new Map<number, { count: number; revenue: number }>();
    for (const c of cases) {
      if (!map.has(c.lab_id)) map.set(c.lab_id, { count: 0, revenue: 0 });
      const entry = map.get(c.lab_id)!;
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
        name: labs.find((l) => l.id === id)?.name ?? `Lab #${id}`,
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
        name: labs.find((l) => l.id === id)?.name ?? `Lab #${id}`,
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

export const clientChanges = getClientChanges(20);

export type HeatmapSort = "last-active" | "total-cases" | "name";

export interface HeatmapRow {
  labId: number;
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
  limit = 40,
  sort: HeatmapSort = "last-active",
  dateRange?: { from: string; to: string },
): HeatmapData {
  const filtered = dateRange
    ? incomingCases.filter((c) => c.order_date >= dateRange.from && c.order_date <= dateRange.to)
    : incomingCases;

  const dates = Array.from(new Set(filtered.map((c) => c.order_date))).sort();

  const labMap = new Map<
    number,
    { totalCases: number; lastActive: string; firstActive: string; cells: Record<string, number> }
  >();

  for (const c of filtered) {
    if (!labMap.has(c.lab_id)) {
      labMap.set(c.lab_id, {
        totalCases: 0,
        lastActive: c.order_date,
        firstActive: c.order_date,
        cells: {},
      });
    }
    const entry = labMap.get(c.lab_id)!;
    entry.totalCases += 1;
    if (c.order_date > entry.lastActive) entry.lastActive = c.order_date;
    if (c.order_date < entry.firstActive) entry.firstActive = c.order_date;
    entry.cells[c.order_date] = (entry.cells[c.order_date] ?? 0) + 1;
  }

  let rows: HeatmapRow[] = Array.from(labMap.entries()).map(([id, v]) => ({
    labId: id,
    labName: labs.find((l) => l.id === id)?.name ?? `Lab #${id}`,
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

export function getSummary() {
  const totalRevenue = incomingCases.reduce((sum, c) => sum + c.amount, 0);
  const totalCases = incomingCases.length;
  const uniqueLabCount = new Set(incomingCases.map((c) => c.lab_id)).size;
  const uniqueDoctorCount = new Set(incomingCases.map((c) => c.doctor_id))
    .size;
  const uniquePatientCount = new Set(incomingCases.map((c) => c.patient_id))
    .size;
  const shipped = incomingCases.filter((c) => c.status === "Shipped").length;
  const inProduction = incomingCases.filter(
    (c) => c.status === "In Production",
  ).length;
  const hold = incomingCases.filter((c) => c.status === "Hold").length;

  const dates = incomingCases.map((c) => c.order_date).sort();
  const dateRange = { from: dates[0], to: dates[dates.length - 1] };

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
