import { NextResponse, type NextRequest } from 'next/server'
import { sessionSecret, type BoundaryMode } from './lib/authEnv'
import { boundaryVerdict } from './lib/boundary'
import { SESSION_COOKIE, verifySession } from './lib/session'

/**
 * The browser boundary (M15 spec §2.2, M23 spec §7 F4). Every decision lives in `lib/boundary.ts`;
 * this file only extracts headers, asks `lib/session.ts` about the cookie, and speaks HTTP. It
 * stays STATELESS on purpose — the edge runtime cannot reach Postgres, so a signature and an
 * expiry are all it checks. Whether the user the cookie names still exists is
 * `server/principal.ts`'s question, asked where a database is available.
 *
 * A refused page request gets the same JSON 403 a refused API request does — a foreign-host page
 * fetch is a rebinding probe, not a person to render an error page for. An unauthenticated page
 * request IS a person: it goes to /login with the path to come back to.
 *
 * That redirect's Location is built from the REQUEST'S OWN `Host`, not from `nextUrl`: Next
 * normalises `nextUrl`'s host to `localhost` and ignores both `Host` and `X-Forwarded-Host` (only
 * the proto follows the forwarded header) — measured under `next dev` AND `next start`. A
 * `NextResponse.redirect(nextUrl.clone())` therefore sends a tailnet client to ITS OWN localhost,
 * which is exactly the deployment M20 exists for. A relative Location would be the tidier fix but
 * is not available: the adapter's `new NextURL(location)` call in `next/dist/server/web/adapter.js`
 * parses every `Location` with no base, and answers 500 `TypeError: Invalid URL`.
 * So the host the operator typed is echoed back, and the adapter leaves a non-`localhost` host
 * alone. Which hosts may reach this line is `boundary.ts`'s business, not this file's: loopback
 * mode already refused every foreign host above, and accounts mode answers to any host on purpose.
 * Spec §2.4: `302 to /login?next=<pathname + search>`.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const secret = sessionSecret()
  const mode: BoundaryMode = secret === null ? 'loopback-only' : 'accounts'
  const session =
    secret === null ? null : await verifySession(secret, request.cookies.get(SESSION_COOKIE)?.value ?? null, new Date())

  const verdict = boundaryVerdict({
    mode,
    host: request.headers.get('host'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    origin: request.headers.get('origin'),
    path: request.nextUrl.pathname,
    sessionValid: session !== null,
  })
  if (verdict.allow) return NextResponse.next()
  if (verdict.kind === 'refused') return NextResponse.json({ error: verdict.reason }, { status: 403 })
  if (request.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: verdict.reason }, { status: 401 })

  // `||`, not `??`: a header sent with an EMPTY value reads back as `''`, not `null`, and the two
  // empties fail differently — measured, not assumed. An empty proto (`://host/login`) is
  // unparsable and the adapter turns it into the same 500 a relative Location gives; an empty host
  // (`http:///login`) PARSES, to host `login`, so the browser would be sent silently to
  // `http://login/…` — a wrong-host redirect, not an error. Both are why `nextUrl` is the fallback
  // for each half: its own scheme and host are well-formed by parsing. The proto is allowlisted
  // rather than merely non-empty so nothing else (`X-Forwarded-Proto: javascript`) can reach the
  // header.
  const next = encodeURIComponent(`${request.nextUrl.pathname}${request.nextUrl.search}`)
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : request.nextUrl.protocol.replace(':', '')
  const host = request.headers.get('host') || request.nextUrl.host
  return new NextResponse(null, { status: 302, headers: { location: `${proto}://${host}/login?next=${next}` } })
}
