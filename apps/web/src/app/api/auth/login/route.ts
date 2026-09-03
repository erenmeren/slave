import { verifyCredentials } from '@ai-team-os/control'
import { sessionSecret } from '../../../../lib/authEnv'
import { mintSession, requestIsHttps, sessionCookieHeader } from '../../../../lib/session'

export const dynamic = 'force-dynamic'

/** The brute-force story (M20 spec §3.1, M21 B3, widened to named accounts in M23 F5): a wrong
 *  guess costs 300 ms AND takes its turn — failures are queued through `failureGate`, so N
 *  concurrent wrong guesses complete at 300, 600, … N×300 ms and one process answers at most ~3.3
 *  guesses a second regardless of connection count. An UNKNOWN username takes the same queue as a
 *  wrong password: the two are one answer, so the queue cannot be used to enumerate names either.
 *  `verifyCredentials` does its own half of that job — it runs the PBKDF2 derivation against a
 *  dummy hash when the user is missing, so the two branches cost the same before the gate.
 *  What this does not bound: a distributed attacker across many processes, and it is not a lockout
 *  — the password's entropy is the real defence (README says so). Successes never touch the queue.
 *  The queue does not drain on client abort: N aborted wrong guesses still delay the next failure
 *  by N×300 ms. */
const FAILED_LOGIN_DELAY_MS = 300
let failureGate: Promise<void> = Promise.resolve()

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fieldFrom(body: unknown, key: 'username' | 'password'): string {
  if (body === null || typeof body !== 'object') return ''
  const candidate = (body as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : ''
}

export async function POST(request: Request): Promise<Response> {
  const secret = sessionSecret()
  if (secret === null) {
    return Response.json({ error: 'accounts are not configured on this instance' }, { status: 404 })
  }
  const body: unknown = await request.json().catch(() => null)
  // A malformed body is a wrong guess: same delay, same answer — nothing to learn from the shape.
  const user = await verifyCredentials(fieldFrom(body, 'username'), fieldFrom(body, 'password'))
  if (user === null) {
    failureGate = failureGate.then(() => delay(FAILED_LOGIN_DELAY_MS))
    await failureGate
    // The name that was guessed stays out of the log: a log line is not the place to accumulate
    // an attacker's dictionary, and the operator can learn nothing from it that the count does not
    // already say.
    console.warn('[auth] failed login attempt')
    return Response.json({ error: 'wrong username or password' }, { status: 401 })
  }
  const value = await mintSession(secret, user.id, new Date())
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': sessionCookieHeader(value, { secure: requestIsHttps(request) }) },
  })
}
