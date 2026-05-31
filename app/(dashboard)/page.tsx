"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
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
  type TimeGranularity,
} from "@/lib/data";

const summary = getSummary();
const categories = getCategoryBreakdown();
const topLabs = getTopLabs(10);
const topDoctors = getTopDoctors(10);

export default function Page() {
  const [granularity, setGranularity] = useState<TimeGranularity>("daily");
  const timeSeries = getTimeSeries(granularity);

  return (
    <main className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Operations Overview</h2>
        <Badge variant="secondary" className="text-xs">
          {summary.dateRange.from} — {summary.dateRange.to}
        </Badge>
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

        <ClientHeatmap />
      </div>
    </main>
  );
}
