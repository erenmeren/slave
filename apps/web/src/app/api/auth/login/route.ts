import { configuredPassword } from '../../../../lib/authEnv'
import { digestEqual, mintSession, requestIsHttps, sessionCookieHeader } from '../../../../lib/session'

export const dynamic = 'force-dynamic'

/** The whole brute-force story this milestone: one operator, one secret, no table — a wrong
 *  guess costs 300 ms and one log line (M20 spec §3.1). */
const FAILED_LOGIN_DELAY_MS = 300

function passwordFrom(body: unknown): string {
  if (body === null || typeof body !== 'object') return ''
  const candidate = (body as { password?: unknown }).password
  return typeof candidate === 'string' ? candidate : ''
}

export async function POST(request: Request): Promise<Response> {
  const password = configuredPassword()
  if (password === null) {
    return Response.json({ error: 'password login is not configured on this instance' }, { status: 404 })
  }
  const body: unknown = await request.json().catch(() => null)
  // A malformed body is a wrong password: same delay, same answer — nothing to learn from the shape.
  if (!(await digestEqual(passwordFrom(body), password))) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS))
    console.warn('[auth] failed login attempt')
    return Response.json({ error: 'wrong password' }, { status: 401 })
  }
  const value = await mintSession(password, new Date())
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': sessionCookieHeader(value, { secure: requestIsHttps(request) }) },
  })
}
