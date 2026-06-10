"use client"

import {
  startOfWeek,
  startOfMonth,
  subDays,
  subWeeks,
  subMonths,
  format,
} from "date-fns"
import type { DateRange } from "react-day-picker"
import { ListFilter } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const PRESETS = [
  { label: "Previous 1 week", unit: "week", amount: 1 },
  { label: "Previous 2 weeks", unit: "week", amount: 2 },
  { label: "Previous 3 weeks", unit: "week", amount: 3 },
  { label: "Previous 1 month", unit: "month", amount: 1 },
  { label: "Previous 2 months", unit: "month", amount: 2 },
  { label: "Previous 3 months", unit: "month", amount: 3 },
] as const

// "Previous N weeks/months" = the N most recent fully-completed calendar
// periods, ending at the last day before the current week/month started.
function resolveRange(
  unit: "week" | "month",
  amount: number
): { from: Date; to: Date } {
  const today = new Date()
  if (unit === "week") {
    const currentWeekStart = startOfWeek(today, { weekStartsOn: 1 })
    return {
      from: subWeeks(currentWeekStart, amount),
      to: subDays(currentWeekStart, 1),
    }
  }
  const currentMonthStart = startOfMonth(today)
  return {
    from: subMonths(currentMonthStart, amount),
    to: subDays(currentMonthStart, 1),
  }
}

export function QuickRangeFilter({
  onSelect,
}: {
  onSelect: (range: DateRange) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label="Quick date filter">
          <ListFilter />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">Quick filter</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {PRESETS.map((p) => {
          const range = resolveRange(p.unit, p.amount)
          return (
            <DropdownMenuItem
              key={p.label}
              className="flex flex-col items-start gap-0.5 text-xs"
              onClick={() => onSelect(range)}
            >
              <span>{p.label}</span>
              <span className="text-muted-foreground">
                {format(range.from, "MMM d")} –{" "}
                {format(range.to, "MMM d, yyyy")}
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
