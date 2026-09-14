'use client'

/**
 * The handoff's segmented control (README: "1px `--line2` border, radius 8-9, 2px padding; the
 * chosen segment takes `--sel`, weight 600 and `--t1`").
 *
 * ONE implementation for the five surfaces that draw it (M57 R21): Tasks' Board/List, Knowledge's
 * three filters, Workforce's two sub-segments, Settings' Appearance, and the permission matrix's
 * three-way. Presentational and uncontrolled-free: the caller owns `value` and `onChange`, so a
 * segment that navigates and a segment that sets state are the same component.
 *
 * `testIdPrefix` is required rather than defaulted, because every one of those five surfaces has a
 * gate or a test that names its segments and a shared default would make four of them collide.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  testIdPrefix,
}: {
  readonly options: readonly { readonly id: T; readonly label: string; readonly count?: number }[]
  readonly value: T
  readonly onChange: (next: T) => void
  readonly ariaLabel: string
  readonly testIdPrefix: string
}): React.JSX.Element {
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      data-testid={testIdPrefix}
      data-value={value}
      className="inline-flex gap-[2px] rounded-card border border-line2 p-[2px]"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`${testIdPrefix}-${option.id}`}
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
          className={`rounded-nav border-0 px-[10px] py-1 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            option.id === value ? 'bg-sel font-semibold text-t1' : 'bg-transparent text-t2 hover:text-t1'
          }`}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="ml-[6px] font-mono text-[11px] font-medium text-t3">{option.count}</span>
          )}
        </button>
      ))}
    </span>
  )
}
