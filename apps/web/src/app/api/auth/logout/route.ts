import { requestIsHttps, sessionCookieHeader } from '../../../../lib/session'

export const dynamic = 'force-dynamic'

/** Clears the session cookie. 204 always — a stale or absent cookie logging out is not an error.
 *  The middleware already refused a cross-site call and 401'd an unauthenticated one before this
 *  ran (M20 spec §3.2). */
export function POST(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': sessionCookieHeader(null, { secure: requestIsHttps(request) }) },
  })
}
