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
} as const

export function Alert({
  variant,
  testId,
  children,
}: {
  readonly variant: 'error' | 'notice' | 'success'
  readonly testId?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="alert"
      data-variant={variant}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className={`border-b px-4 py-1.5 text-xs ${SURFACE[variant]}`}
    >
      {children}
    </div>
  )
}
