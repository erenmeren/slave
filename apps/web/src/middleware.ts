import { NextResponse, type NextRequest } from 'next/server'
import { configuredPassword, type BoundaryMode } from './lib/authEnv'
import { boundaryVerdict } from './lib/boundary'
import { SESSION_COOKIE, verifyBearer, verifySession } from './lib/session'

/**
 * The browser boundary (M15 spec §2.2, M20 spec §2.4). Every decision lives in `lib/boundary.ts`;
 * this file only extracts headers, asks `lib/session.ts` about the credentials, and speaks HTTP.
 * A refused page request gets the same JSON 403 a refused API request does — a foreign-host page
 * fetch is a rebinding probe, not a person to render an error page for. An unauthenticated page
 * request IS a person: it goes to /login with the path to come back to.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const password = configuredPassword()
  const mode: BoundaryMode = password === null ? 'loopback-only' : 'password'
  const [sessionValid, bearerValid] =
    password === null
      ? [false, false]
      : await Promise.all([
          verifySession(password, request.cookies.get(SESSION_COOKIE)?.value ?? null, new Date()),
          verifyBearer(password, request.headers.get('authorization')),
        ])

  const verdict = boundaryVerdict({
    mode,
    host: request.headers.get('host'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    origin: request.headers.get('origin'),
    path: request.nextUrl.pathname,
    sessionValid,
    bearerValid,
  })
  if (verdict.allow) return NextResponse.next()
  if (verdict.kind === 'refused') return NextResponse.json({ error: verdict.reason }, { status: 403 })
  if (request.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: verdict.reason }, { status: 401 })

  const login = request.nextUrl.clone()
  login.pathname = '/login'
  login.search = ''
  login.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(login, 302)
}
