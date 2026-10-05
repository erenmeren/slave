import { cn } from '@/lib/utils'
import { dayWord, labelledDays, niceCeiling, type Column } from './words'

/**
 * A column per day, hand-made from plain boxes -- no chart library. A column's parts are stacked
 * bottom first; the scale runs to a round number at or above the busiest day, so days are compared
 * against each other. A day with nothing is an empty slot, never left out. With no figure on any
 * day the frame still stands, and `empty` says why it is bare.
 */
export function DayBars({ id, label, columns, format, empty }: { readonly id: string; readonly label: string; readonly columns: readonly Column[]; readonly format: (value: number) => string; readonly empty: string }): React.JSX.Element {
  if (columns.length === 0) {
    return (
      <p data-testid={`${id}-empty`} className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        {empty}
      </p>
    )
  }
  const max = Math.max(...columns.map((column) => column.total))
  const ceiling = niceCeiling(max)
  const labelled = labelledDays(columns.length)
  const gap = columns.length <= 8 ? 'gap-3' : columns.length <= 31 ? 'gap-1' : 'gap-px'
  const values = columns.length <= 10
  return (
    <div role="img" aria-label={label} data-testid={id} className="flex min-w-0 flex-col gap-1">
      <div className="flex gap-2">
        <div aria-hidden className="flex h-44 w-11 shrink-0 flex-col justify-between text-right text-[11px] leading-none text-muted-foreground tabular-nums">
          <span>{format(ceiling)}</span>
          <span>{format(ceiling / 2)}</span>
          <span>0</span>
        </div>
        <div className="relative h-44 min-w-0 flex-1 border-b">
          <div aria-hidden className="absolute inset-x-0 top-0 border-t border-dashed" />
          <div aria-hidden className="absolute inset-x-0 top-1/2 border-t border-dashed" />
          {max <= 0 && (
            <p data-testid={`${id}-empty`} className="absolute inset-0 grid place-items-center px-4 text-center text-sm text-muted-foreground">
              {empty}
            </p>
          )}
          <div className={cn('absolute inset-0 flex items-end', gap)}>
            {columns.map((column) => (
              <div
                key={column.day}
                data-testid={`${id}-column`}
                data-day={column.day}
                data-value={column.total}
                title={`${dayWord(column.day)}: ${column.total > 0 ? format(column.total) : 'nothing'}${column.segments.length > 1 ? ` (${column.segments.map((segment) => `${segment.name} ${format(segment.value)}`).join(', ')})` : ''}`}
                className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              >
                {values && column.total > 0 && <span className="text-[11px] leading-none whitespace-nowrap text-muted-foreground tabular-nums">{format(column.total)}</span>}
                {column.total > 0 && (
                  <div className="flex w-full max-w-10 flex-col-reverse overflow-hidden rounded-t-sm transition-opacity group-hover:opacity-80" style={{ height: `${String((column.total / ceiling) * 100)}%`, minHeight: 3 }}>
                    {column.segments.map((segment) => (
                      <div key={segment.id} data-series={segment.id} className={cn('min-h-px w-full border-t border-background first:border-t-0', segment.tone)} style={{ flex: `${String(segment.value)} 0 0` }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div aria-hidden className={cn('ml-[52px] flex', gap)}>
        {columns.map((column, index) => (
          <div key={column.day} className="relative h-4 min-w-0 flex-1">
            {labelled.has(index) && (
              <span className={cn('absolute top-0 text-[11px] leading-4 whitespace-nowrap text-muted-foreground', index === columns.length - 1 && columns.length > 8 ? 'right-0' : 'left-1/2 -translate-x-1/2')}>{dayWord(column.day)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** What each tone of a stacked chart stands for. */
export function Legend({ series }: { readonly series: readonly { readonly id: string; readonly name: string; readonly tone: string }[] }): React.JSX.Element | null {
  if (series.length < 2) return null
  return (
    <ul data-testid="chart-legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((one) => (
        <li key={one.id} className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={cn('size-2.5 shrink-0 rounded-[3px]', one.tone)} />
          <span className="max-w-[220px] truncate" title={one.name}>{one.name}</span>
        </li>
      ))}
    </ul>
  )
}

/** One figure with its label and a line under it, as the Project screen's own figures are drawn. */
export function Figure({ id, label, value, detail, tone }: { readonly id: string; readonly label: string; readonly value: string; readonly detail: string | null; readonly tone?: string }): React.JSX.Element {
  return (
    <div data-testid={`figure-${id}`} className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card p-3">
      <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {tone !== undefined && <span aria-hidden className={cn('size-2 rounded-full', tone)} />}
        {label}
      </span>
      <span className="text-xl leading-tight font-semibold tabular-nums [overflow-wrap:anywhere]">{value}</span>
      {detail !== null && <span className="line-clamp-2 text-xs text-muted-foreground" title={detail}>{detail}</span>}
    </div>
  )
}
