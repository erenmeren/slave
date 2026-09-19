'use client'

import Link from 'next/link'
import { useLayoutEffect, useRef, useState } from 'react'

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
 *
 * An option that carries `href` (M57 t8 fix round 1, ruling T8-2 -- Workforce's two sub-segments,
 * which navigate) renders as a `next/link` `<Link>` instead of a `<button>`: same testid, same
 * class string (the focus ring included), `aria-current="page"` when selected instead of
 * `aria-pressed`/`aria-selected` (a link's implicit `role="link"` has no `aria-selected`/
 * `aria-pressed` in the ARIA spec -- stamping either is invalid ARIA). `onChange` still fires on
 * click either way, so a caller that also needs local state updated on click (Workforce does, to
 * close the race a navigation-only update leaves open) gets it synchronously, before the
 * navigation itself lands.
 *
 * M61 R16: a `segmented-indicator` span slides under the chosen option, measured off that
 * option's own `offsetLeft`/`offsetWidth` in a layout effect keyed on `value` -- 0/0 in jsdom
 * (no real layout there), which is fine, since nothing asserts its geometry in a unit test. The
 * button variant now also carries `aria-selected` alongside the pre-existing `aria-pressed` (the
 * link variant still carries neither, per the ARIA-validity note above).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  testIdPrefix,
  data,
}: {
  readonly options: readonly { readonly id: T; readonly label: string; readonly count?: number; readonly href?: string }[]
  readonly value: T
  readonly onChange: (next: T) => void
  readonly ariaLabel: string
  readonly testIdPrefix: string
  /** Extra `data-*` attributes for the group element -- spread BEFORE `data-testid`/`data-value`,
   *  so a caller cannot accidentally shadow either (`ui/Card`'s own `data` prop documents the same
   *  reasoning). Settings' Appearance section (M57 t8) is the one caller: the gate reads the
   *  CHOSEN mode's `data-theme-mode` off this same group element, not off a wrapper this component
   *  does not itself render. */
  readonly data?: Readonly<Record<`data-${string}`, string>>
}): React.JSX.Element {
  const optionRefs = useRef(new Map<T, HTMLElement>())
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({ left: 0, width: 0 })

  useLayoutEffect(() => {
    const el = optionRefs.current.get(value)
    setIndicator(el === undefined ? { left: 0, width: 0 } : { left: el.offsetLeft, width: el.offsetWidth })
  }, [value, options])

  return (
    <span
      {...data}
      role="group"
      aria-label={ariaLabel}
      data-testid={testIdPrefix}
      data-value={value}
      className="relative inline-flex gap-[2px] rounded-card border border-line2 p-[2px]"
    >
      <span
        aria-hidden
        data-testid="segmented-indicator"
        className="absolute inset-y-[2px] rounded-nav bg-sel transition-[transform,width] duration-[var(--dur-base)] ease-[var(--ease-in-out)]"
        style={{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px`, left: 0 }}
      />
      {options.map((option) => {
        const selected = option.id === value
        const className = `relative z-[1] rounded-nav border-0 px-[10px] py-1 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          selected ? 'font-semibold text-t1' : 'bg-transparent text-t2 hover:text-t1'
        }`
        const label = (
          <>
            {option.label}
            {option.count !== undefined && (
              <span className="ml-[6px] font-mono text-[11px] font-medium text-t3">{option.count}</span>
            )}
          </>
        )
        // One ref callback shape for both branches -- the `Map` just tracks whichever DOM node
        // (an `<a>` or a `<button>`) currently renders this option, for the indicator's own
        // layout effect above to measure.
        const ref = (el: HTMLElement | null): void => {
          if (el === null) optionRefs.current.delete(option.id)
          else optionRefs.current.set(option.id, el)
        }
        if (option.href !== undefined) {
          return (
            <Link
              key={option.id}
              ref={ref}
              href={option.href}
              data-testid={`${testIdPrefix}-${option.id}`}
              aria-current={selected ? 'page' : undefined}
              onClick={() => onChange(option.id)}
              className={className}
            >
              {label}
            </Link>
          )
        }
        return (
          <button
            key={option.id}
            ref={ref}
            type="button"
            data-testid={`${testIdPrefix}-${option.id}`}
            aria-pressed={selected}
            aria-selected={selected}
            onClick={() => onChange(option.id)}
            className={className}
          >
            {label}
          </button>
        )
      })}
    </span>
  )
}
