"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import type { TimeSeriesPoint } from "@/lib/data"

// Minimum horizontal space per data point. With daily granularity over a few months
// this pushes the chart past the card width so it scrolls; for weekly/monthly the
// computed min-width stays under the card and the chart just fills it (no scroll).
const MIN_PX_PER_POINT = 44

// While the skeleton is up the scrollable inner div is gone, so the browser clamps
// scrollLeft back to 0 and the remounted chart measures its final width once,
// instead of Recharts re-rendering mid-resize at a stale width/scroll offset.
const SWITCH_DELAY_MS = 200

interface ChartScrollContainerProps {
  data: TimeSeriesPoint[]
  children: ReactNode
}

export function ChartScrollContainer({
  data,
  children,
}: ChartScrollContainerProps) {
  // The series currently on screen; starts null so SSR/hydration renders the
  // skeleton until the container can be measured client-side.
  const [visible, setVisible] = useState<TimeSeriesPoint[] | null>(null)

  useEffect(() => {
    if (visible === data) return
    const t = setTimeout(() => setVisible(data), SWITCH_DELAY_MS)
    return () => clearTimeout(t)
  }, [data, visible])

  return (
    <div className="h-[280px] overflow-x-auto">
      {visible !== data ? (
        <Skeleton className="size-full" />
      ) : (
        <div
          className="h-full"
          style={{ minWidth: `${data.length * MIN_PX_PER_POINT}px` }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
