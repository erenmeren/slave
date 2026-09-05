/**
 * The one place `SLAVEOFAI_SESSION_SECRET` is read (M23 spec §7 F1). Empty or absent → loopback
 * mode, M15 byte for byte; a non-empty value → accounts mode, where the app answers to any Host
 * and every request carries a user-bound session cookie. `SLAVEOFAI_PASSWORD` is retired with M20's
 * single shared secret: there is no reader for it anywhere in the app any more.
 *
 * `boundary.ts` and `session.ts` stay pure and receive the mode/secret as arguments; the
 * middleware, `server/principal.ts`, the two auth routes, the login page and the Settings page are
 * the callers of this module, and nothing else is.
 */
export type BoundaryMode = 'loopback-only' | 'accounts'

/** The trimmed signing secret, or null when the instance runs without accounts. */
export function sessionSecret(): string | null {
  const raw = process.env['SLAVEOFAI_SESSION_SECRET']
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

export function boundaryMode(): BoundaryMode {
  return sessionSecret() === null ? 'loopback-only' : 'accounts'
}
