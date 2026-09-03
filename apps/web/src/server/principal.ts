import { cookies } from 'next/headers'
import { prisma } from '@ai-team-os/db/client'
import { sessionSecret } from '../lib/authEnv'
import { SESSION_COOKIE, verifySession } from '../lib/session'

export interface Principal {
  readonly userId: string
  readonly username: string
}

/** The signed-in user, or null: loopback mode (no accounts), no/invalid cookie, or a cookie
 *  whose user was deleted since — the one revocation story (spec §7 F4). Stateless middleware
 *  admitted the request; this is where the database gets its say. */
export async function currentPrincipal(): Promise<Principal | null> {
  const secret = sessionSecret()
  if (secret === null) return null
  const value = (await cookies()).get(SESSION_COOKIE)?.value ?? null
  const session = await verifySession(secret, value, new Date())
  if (session === null) return null
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, username: true } })
  return user === null ? null : { userId: user.id, username: user.username }
}

/** For API routes in accounts mode: a null principal is 401 `session revoked`. In loopback mode
 *  there is no principal to require, and the writes carry no user, as they always have. */
export async function requirePrincipal(): Promise<{ principal: Principal | null } | { response: Response }> {
  if (sessionSecret() === null) return { principal: null }
  const principal = await currentPrincipal()
  return principal === null ? { response: Response.json({ error: 'session revoked' }, { status: 401 }) } : { principal }
}
