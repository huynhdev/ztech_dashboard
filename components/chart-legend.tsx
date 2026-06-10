"use client"

export interface ChartSeries {
  key: string
  name: string
  color: string
}

interface ChartLegendProps {
  series: ChartSeries[]
  hidden: Set<string>
  onToggle: (key: string) => void
}

export function ChartLegend({ series, hidden, onToggle }: ChartLegendProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {series.map((s) => {
        const isHidden = hidden.has(s.key)
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onToggle(s.key)}
            aria-pressed={!isHidden}
            className="flex items-center gap-1.5 text-xs transition-opacity hover:opacity-80"
            style={{ opacity: isHidden ? 0.4 : 1 }}
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            <span className={isHidden ? "line-through" : undefined}>
              {s.name}
            </span>
          </button>
        )
      })}
    </div>
  )
}
