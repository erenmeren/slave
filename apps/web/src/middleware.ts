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
    host: request.headers.get('host'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    origin: request.headers.get('origin'),
    path: request.nextUrl.pathname,
  })
  if (!verdict.allow) return NextResponse.json({ error: verdict.reason }, { status: 403 })
  return NextResponse.next()
}
