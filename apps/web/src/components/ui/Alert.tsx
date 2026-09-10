import type React from 'react'

/**
 * The full-width band (M44 R3): the shape `OverviewClient`, `TasksClient` and `GraphClient` each
 * hand-rolled for "showing stale data", each with its own class string and a comment saying no
 * `ui/` component covered it.
 *
 * NOT a replacement for the ~50 inline `role="alert"` refusal sentences under forms -- those are
 * one consistent convention already, and rewriting them was never the point (plan erratum E21).
 * `HaltBanner` also keeps its own component: four gates key off it by name.
 */
const SURFACE = {
  error: 'border-tone-blocked/40 bg-tone-blocked/10 text-tone-blocked',
  notice: 'border-tone-waiting/40 bg-tone-waiting/10 text-tone-waiting',
  success: 'border-tone-done/40 bg-tone-done/10 text-tone-done',
  // No tone at all: the page's own hairline and card ground. A provenance line is not a status.
  info: 'border-line bg-bg-1 text-text-3',
} as const

/**
 * `info` is the band that is NOT an alert (fix round 1). The other three say something has gone
 * wrong or has just gone right, which is what `role="alert"` is for -- an assertive live region a
 * screen reader interrupts itself to read. `info` carries standing PROVENANCE ("this organisation
 * was adopted from a simulation"): it is true for the life of the project, it needs nobody, and
 * announcing it on insertion -- in amber, beside three genuinely amber bands -- was a warning
 * about nothing. `role="status"` is polite, and the surface is the page's own neutral.
 */
const ROLE: Record<keyof typeof SURFACE, 'alert' | 'status'> = {
  error: 'alert',
  notice: 'alert',
  success: 'alert',
  info: 'status',
}

export function Alert({
  variant,
  testId,
  children,
}: {
  readonly variant: 'error' | 'notice' | 'success' | 'info'
  readonly testId?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role={ROLE[variant]}
      data-variant={variant}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className={`border-b px-4 py-1.5 text-xs ${SURFACE[variant]}`}
    >
      {children}
    </div>
  )
}
