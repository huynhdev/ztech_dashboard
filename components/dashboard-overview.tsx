"use client";

import { useMemo, useState } from "react";
import { format, parseISO, subDays } from "date-fns";
import type { DateRange } from "react-day-picker";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DateRangePicker } from "@/components/date-range-picker";
import { KpiCards } from "@/components/kpi-cards";
import { RevenueChart } from "@/components/revenue-chart";
import { CustomerChart } from "@/components/customer-chart";
import { VolumeChart } from "@/components/volume-chart";
import { CategoryChart } from "@/components/category-chart";
import { TopTable } from "@/components/top-table";
import { ClientHeatmap } from "@/components/client-heatmap";
import {
  getSummary,
  getTimeSeries,
  getCategoryBreakdown,
  getTopLabs,
  getTopDoctors,
  type CaseRow,
  type TimeGranularity,
} from "@/lib/data";

// Default the global filter to the 30 days ending at the latest order date,
// clamped to the earliest date so a dataset shorter than 30 days still shows in full.
function defaultRange(cases: CaseRow[]): DateRange | undefined {
  if (cases.length === 0) return undefined;
  let min = cases[0].orderDate;
  let max = cases[0].orderDate;
  for (const c of cases) {
    if (c.orderDate < min) min = c.orderDate;
    if (c.orderDate > max) max = c.orderDate;
  }
  const to = parseISO(max);
  const minDate = parseISO(min);
  const from = subDays(to, 29);
  return { from: from < minDate ? minDate : from, to };
}

export function DashboardOverview({ cases }: { cases: CaseRow[] }) {
  const [granularity, setGranularity] = useState<TimeGranularity>("daily");
  const [range, setRange] = useState<DateRange | undefined>(() =>
    defaultRange(cases),
  );

  // A complete range filters; an empty/partial one shows every case.
  const filteredCases = useMemo(() => {
    if (!range?.from || !range?.to) return cases;
    const from = format(range.from, "yyyy-MM-dd");
    const to = format(range.to, "yyyy-MM-dd");
    return cases.filter((c) => c.orderDate >= from && c.orderDate <= to);
  }, [cases, range]);

  const summary = useMemo(() => getSummary(filteredCases), [filteredCases]);
  const categories = useMemo(
    () => getCategoryBreakdown(filteredCases),
    [filteredCases],
  );
  const topLabs = useMemo(() => getTopLabs(filteredCases, 10), [filteredCases]);
  const topDoctors = useMemo(
    () => getTopDoctors(filteredCases, 10),
    [filteredCases],
  );
  const timeSeries = useMemo(
    () => getTimeSeries(filteredCases, granularity),
    [filteredCases, granularity],
  );

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Operations Overview</h2>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <div className="flex flex-col gap-4">
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

        <div className="grid gap-4 lg:grid-cols-2">
          <RevenueChart data={timeSeries} />
          <CustomerChart data={timeSeries} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <VolumeChart data={timeSeries} />
          <CategoryChart data={categories} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <TopTable title="Top 10 Labs" data={topLabs} />
          <TopTable title="Top 10 Doctors" data={topDoctors} />
        </div>

        <ClientHeatmap cases={filteredCases} />
      </div>
    </>
  );
}
