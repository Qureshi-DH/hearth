import { useRef, useState, type KeyboardEvent } from "react"

import { count } from "../format"

/** A round number at or above the largest value, so gridlines land on 0, half and all of it. */
export function niceMax(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find((m) => m * power >= value) ?? 10
  return step * power
}

/** A trend under a number, for the eye rather than for reading off. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null
  const max = Math.max(1, ...values)
  const step = 100 / (values.length - 1)
  // A series that never moves is drawn as a level line, not a full block.
  const level = values.every((value) => value === values[0])
  const points = values.map((value, i) => [i * step, level ? 18 : 30 - (value / max) * 27] as const)
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`)
  const area = `${line.join(" ")} L100 32 L0 32 Z`
  return (
    <svg className="spark" viewBox="0 0 100 32" preserveAspectRatio="none" role="img">
      <title>{label}</title>
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line.join(" ")} />
    </svg>
  )
}

interface Series {
  key: string
  label: string
  values: number[]
}

/**
 * Columns, one per day, stacked when there is more than one series. The chart
 * is one tab stop, and the arrow keys walk its days, so a keyboard gets past
 * it in one press and the focused day shows the same tip a hover does.
 */
export function Columns({
  label,
  days,
  series,
  unit,
  empty,
}: {
  /** The chart's name for a screen reader. */
  label: string
  days: string[]
  series: Series[]
  /** What one of the counted things is called, for the column's own label. */
  unit: (n: number) => string
  /** Said in place of a flat chart when every day is zero. */
  empty: string
}) {
  const [chosen, setChosen] = useState(days.length - 1)
  const columns = useRef<Array<HTMLLIElement | null>>([])
  const active = Math.max(0, Math.min(chosen, days.length - 1))
  const totals = days.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))
  const max = niceMax(Math.max(...totals))
  if (totals.every((total) => total === 0)) {
    return (
      <div className="columns">
        <div className="columns-grid" aria-hidden="true">
          <span className="columns-rule" />
          <span className="columns-rule" />
          <span className="columns-rule" />
        </div>
        <p className="columns-empty">{empty}</p>
      </div>
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const moves: Partial<Record<string, number>> = {
      ArrowLeft: active - 1,
      ArrowRight: active + 1,
      Home: 0,
      End: days.length - 1,
    }
    const target = moves[event.key]
    if (target === undefined) return
    event.preventDefault()
    const next = Math.max(0, Math.min(target, days.length - 1))
    setChosen(next)
    columns.current[next]?.focus()
  }

  // The middle line is for the eye and carries no number, since half of a
  // round top can be a fraction no count could be.
  return (
    <div className="columns">
      <div className="columns-grid" aria-hidden="true">
        <span className="columns-rule">
          <span className="columns-tick">{count(max)}</span>
        </span>
        <span className="columns-rule" />
        <span className="columns-rule">
          <span className="columns-tick">0</span>
        </span>
      </div>
      <ol className="columns-bars" aria-label={label} onKeyDown={onKeyDown}>
        {days.map((day, i) => {
          const total = totals[i] ?? 0
          const parts = series
            .map((s) => ({ key: s.key, label: s.label, value: s.values[i] ?? 0 }))
            .filter((part) => part.value > 0)
          const detail =
            series.length > 1 && parts.length > 0
              ? parts.map((part) => `${count(part.value)} ${part.label.toLowerCase()}`).join(", ")
              : unit(total)
          return (
            <li
              key={day}
              ref={(element) => {
                columns.current[i] = element
              }}
              className="column"
              tabIndex={i === active ? 0 : -1}
              aria-label={`${longDay(day)}: ${detail}`}
              onFocus={() => setChosen(i)}
            >
              <span className="column-stack" style={{ height: `${(total / max) * 100}%` }}>
                {parts.map((part) => (
                  <span
                    key={part.key}
                    className={`column-part part-${part.key}`}
                    style={{ flexGrow: part.value }}
                  />
                ))}
              </span>
              <span className="column-label" aria-hidden="true">
                {dayOfMonth(day)}
              </span>
              <span
                className="column-tip"
                aria-hidden="true"
                style={{ bottom: `calc(${(total / max) * 100}% + 8px)` }}
              >
                <strong>{longDay(day)}</strong>
                {series.length > 1 ? (
                  parts.length > 0 ? (
                    parts.map((part) => (
                      <span key={part.key} className="tip-row">
                        <span className={`legend-dot part-${part.key}`} />
                        {count(part.value)} {part.label.toLowerCase()}
                      </span>
                    ))
                  ) : (
                    <span>Nothing</span>
                  )
                ) : (
                  <span>{unit(total)}</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * The server sends calendar days in the viewer's time zone, which
 * `new Date("2026-10-01")` would read as midnight in UTC instead.
 */
function parseDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  const parsed = new Date(year, month, date)
  // Date rolls 2026-02-30 over into March rather than refusing it.
  return parsed.getMonth() === month && parsed.getDate() === date ? parsed : null
}

export function longDay(day: string): string {
  const parsed = parseDay(day)
  return parsed
    ? parsed.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    : day
}

export function dayOfMonth(day: string): string {
  const parsed = parseDay(day)
  return parsed ? String(parsed.getDate()) : day
}
