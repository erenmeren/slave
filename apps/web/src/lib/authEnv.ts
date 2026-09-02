/**
 * The one place `AITEAMOS_PASSWORD` is read (M20 spec §2.1). Empty or absent → loopback mode,
 * M15 byte for byte; anything else → password mode. `boundary.ts` and `session.ts` stay pure and
 * receive the mode/password as arguments; the middleware, the two auth routes, the login page
 * and the Settings page are the callers of this module, and nothing else is.
 */
export type BoundaryMode = 'loopback-only' | 'password'

/** The trimmed password, or null when the instance runs without one. */
export function configuredPassword(): string | null {
  const raw = process.env['AITEAMOS_PASSWORD']
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

export function boundaryMode(): BoundaryMode {
  return configuredPassword() === null ? 'loopback-only' : 'password'
}
