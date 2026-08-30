/**
 * The browser boundary's decision table (M15 spec §2.1). Pure on purpose: no I/O, no Next
 * imports, no env reads — the middleware, the Settings card and the gate all consult this one
 * module, and its unit tests are the rules' specification.
 */
export const POSTURE = 'loopback-only' as const

export interface BoundaryRequest {
  readonly host: string | null
  readonly secFetchSite: string | null
  readonly origin: string | null
  readonly path: string
}

export type BoundaryVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string }

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The host part of a Host-header value: one trailing `:<port>` stripped, brackets kept. A
 *  bracketless IPv6 (invalid in a Host header) mangles here and then fails the allowlist —
 *  refusal is the right answer for malformed input, so no special case. */
function hostOf(value: string): string {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  const colon = value.lastIndexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

export function boundaryVerdict(request: BoundaryRequest): BoundaryVerdict {
  // Rule 1 — every path, every method: both loopback spellings and the IPv6 loopback are the
  // only hosts this instance answers as. Anything else is a DNS-rebinding probe or a mistake.
  const host = request.host === null ? null : hostOf(request.host)
  if (host === null || !ALLOWED_HOSTS.has(host)) {
    return { allow: false, reason: `foreign host ${host ?? '<none>'} — this instance is loopback-only` }
  }

  // Rule 2 — /api/ only, ALL methods including GET: the SSE and JSON GETs leak workspace data,
  // so a cross-site read is refused as firmly as a cross-site write.
  if (!request.path.startsWith('/api/')) return { allow: true }

  if (request.secFetchSite !== null) {
    // The browser set fetch metadata; believe it. `same-origin` is this app's own UI, `none` is
    // the address bar or a non-browser client that chose to send it.
    if (request.secFetchSite === 'same-origin' || request.secFetchSite === 'none') return { allow: true }
    return { allow: false, reason: `cross-site request refused (sec-fetch-site: ${request.secFetchSite})` }
  }

  if (request.origin !== null) {
    // Older browsers without fetch metadata still send Origin on cross-origin requests. The
    // origin's own host must pass the same allowlist — comparing against the allowlist rather
    // than against the request's Host keeps `localhost` ↔ `127.0.0.1` (same machine, different
    // spelling) allowed. An unparsable Origin (including the literal `null`) is refused.
    let originHost: string | null = null
    try {
      originHost = hostOf(new URL(request.origin).host)
    } catch {
      originHost = null
    }
    if (originHost === null || !ALLOWED_HOSTS.has(originHost)) {
      return { allow: false, reason: `cross-origin request refused (origin: ${request.origin})` }
    }
  }

  // Neither header: curl, scripts, the gate — a local process without browser headers is the
  // operator. The boundary defends against browsers.
  return { allow: true }
}
