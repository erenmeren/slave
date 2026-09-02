import { configuredPassword } from '../../../../lib/authEnv'
import { digestEqual, mintSession, requestIsHttps, sessionCookieHeader } from '../../../../lib/session'

export const dynamic = 'force-dynamic'

/** The brute-force story (M20 spec §3.1, M21 B3): one operator, one secret, no table. A wrong guess
 *  costs 300 ms AND takes its turn — failures are queued through `failureGate`, so N concurrent
 *  wrong guesses complete at 300, 600, … N×300 ms and one process answers at most ~3.3 guesses a
 *  second regardless of connection count. What this does not bound: a distributed attacker across
 *  many processes, and it is not a lockout — the password's entropy is the real defence (README
 *  says so). Successes never touch the queue. The queue does not drain on client abort: N aborted
 *  wrong guesses still delay the next failure by N×300 ms. */
const FAILED_LOGIN_DELAY_MS = 300
let failureGate: Promise<void> = Promise.resolve()

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
    failureGate = failureGate.then(() => delay(FAILED_LOGIN_DELAY_MS))
    await failureGate
    console.warn('[auth] failed login attempt')
    return Response.json({ error: 'wrong password' }, { status: 401 })
  }
  const value = await mintSession(password, new Date())
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': sessionCookieHeader(value, { secure: requestIsHttps(request) }) },
  })
}
