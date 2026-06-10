"use client"

import { memo } from "react"
import {
  DollarSign,
  Building2,
  Stethoscope,
  Package,
  Truck,
  Clock,
  PauseCircle,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

interface KpiCardsProps {
  totalRevenue: number
  totalCases: number
  uniqueLabCount: number
  uniqueDoctorCount: number
  shipped: number
  inProduction: number
  hold: number
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

const kpis = [
  {
    key: "totalRevenue" as const,
    label: "Total Revenue",
    icon: DollarSign,
    format: formatCurrency,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
  },
  {
    key: "totalCases" as const,
    label: "Total Cases",
    icon: Package,
    format: (v: number) => v.toLocaleString(),
    color: "text-blue-600",
    bg: "bg-blue-50",
  },
  {
    key: "uniqueLabCount" as const,
    label: "Labs",
    icon: Building2,
    format: (v: number) => v.toLocaleString(),
    color: "text-violet-600",
    bg: "bg-violet-50",
  },
  {
    key: "uniqueDoctorCount" as const,
    label: "Doctors",
    icon: Stethoscope,
    format: (v: number) => v.toLocaleString(),
    color: "text-amber-600",
    bg: "bg-amber-50",
  },
  {
    key: "shipped" as const,
    label: "Shipped",
    icon: Truck,
    format: (v: number) => v.toLocaleString(),
    color: "text-emerald-600",
    bg: "bg-emerald-50",
  },
  {
    key: "inProduction" as const,
    label: "In Production",
    icon: Clock,
    format: (v: number) => v.toLocaleString(),
    color: "text-blue-600",
    bg: "bg-blue-50",
  },
  {
    key: "hold" as const,
    label: "On Hold",
    icon: PauseCircle,
    format: (v: number) => v.toLocaleString(),
    color: "text-red-600",
    bg: "bg-red-50",
  },
]

export const KpiCards = memo(function KpiCards(props: KpiCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
      {kpis.map((kpi) => {
        const Icon = kpi.icon
        return (
          <Card key={kpi.key} className="gap-0 py-4">
            <CardContent className="px-4">
              <div className="flex items-center gap-2">
                <div className={`rounded-md p-1.5 ${kpi.bg}`}>
                  <Icon className={`h-4 w-4 ${kpi.color}`} />
                </div>
                <span className="text-xs text-muted-foreground">
                  {kpi.label}
                </span>
              </div>
              <p className="mt-2 text-xl font-semibold tracking-tight">
                {kpi.format(props[kpi.key])}
              </p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
})
