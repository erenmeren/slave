import { NextResponse, type NextRequest } from 'next/server'
import { boundaryVerdict } from './lib/boundary'

/**
 * The browser boundary (M15 spec §2.2). Every decision lives in `lib/boundary.ts`; this file
 * only extracts headers and speaks HTTP. A refused page request gets the same JSON 403 a
 * refused API request does — a foreign-host page fetch is a rebinding probe, not a person to
 * render an error page for.
 */
export function middleware(request: NextRequest): NextResponse {
  const verdict = boundaryVerdict({
    // M20 Task 4 replaces this bridge with the real mode and the two credential checks; until
    // then the boundary runs exactly M15's loopback rules, which never emit `unauthenticated`.
    mode: 'loopback-only',
    host: request.headers.get('host'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    origin: request.headers.get('origin'),
    path: request.nextUrl.pathname,
    sessionValid: false,
    bearerValid: false,
  })
  if (!verdict.allow) return NextResponse.json({ error: verdict.reason }, { status: 403 })
  return NextResponse.next()
}
