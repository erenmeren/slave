import { assertNever } from './assertNever'
import type { BoundaryMode } from './authEnv'

/**
 * The browser boundary's decision table, in two modes (M15 spec §2.1, M20 spec §2.3). Pure on
 * purpose: no I/O, no Next imports, no env reads — the mode and the credential verdicts arrive
 * as inputs. The middleware, the Settings card and the gates all consult this one module, and
 * its unit tests are the rules' specification.
 */
export interface BoundaryRequest {
  readonly mode: BoundaryMode
  readonly host: string | null
  readonly secFetchSite: string | null
  readonly origin: string | null
  readonly path: string
  /** Password mode only; both false in loopback mode. Computed by the middleware via session.ts. */
  readonly sessionValid: boolean
  readonly bearerValid: boolean
}

export type BoundaryVerdict =
  | { readonly allow: true }
  /** 403 — a browser being used against the operator. */
  | { readonly allow: false; readonly kind: 'refused'; readonly reason: string }
  /** 401 on /api/, 302 to /login on a page — nobody we know yet. */
  | { readonly allow: false; readonly kind: 'unauthenticated'; readonly reason: string }

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Paths that need no credential in either mode: the chunks the login page is made of, the
 *  favicon, the login page, and the login POST itself (which rule 3 still guards). */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/favicon.ico', '/login', '/api/auth/login'])
const PUBLIC_PREFIX = '/_next/'

/** The single source for the Settings card's security line. */
export function postureFor(mode: BoundaryMode): string {
  switch (mode) {
    case 'password':
      return 'password login · single operator · cross-site requests refused'
    case 'loopback-only':
      return 'loopback-only · no accounts · cross-site requests refused'
    default:
      return assertNever(mode)
  }
}

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

function refused(reason: string): BoundaryVerdict {
  return { allow: false, kind: 'refused', reason }
}

/** Rule 3 — /api/ only, ALL methods including GET: the SSE and JSON GETs leak workspace data,
 *  so a cross-site read is refused as firmly as a cross-site write. `null` = no objection. */
function crossSiteRefusal(request: BoundaryRequest): BoundaryVerdict | null {
  if (request.secFetchSite !== null) {
    // The browser set fetch metadata; believe it. `same-origin` is this app's own UI, `none` is
    // the address bar or a non-browser client that chose to send it.
    if (request.secFetchSite === 'same-origin' || request.secFetchSite === 'none') return null
    return refused(`cross-site request refused (sec-fetch-site: ${request.secFetchSite})`)
  }
  if (request.origin !== null) {
    // Older browsers without fetch metadata still send Origin on cross-origin requests. What
    // counts as same-side is per-mode (below); an unparsable Origin (including the literal
    // `null`) is refused in every mode. `URL.host` keeps the port: the loopback branch strips it
    // with `hostOf`, the password branch compares it.
    let originHost: string | null = null
    try {
      originHost = new URL(request.origin).host
    } catch {
      originHost = null
    }
    let sameSide = false
    if (originHost !== null) {
      switch (request.mode) {
        case 'loopback-only':
          // The allowlist, port ignored — keeps `localhost` ↔ `127.0.0.1` allowed (M15).
          sameSide = ALLOWED_HOSTS.has(hostOf(originHost))
          break
        case 'password':
          // The WHATWG host of the Origin (lowercase, default port dropped) must equal the request's
          // own Host header, lowercased, port included: a page on another port of the same tailnet
          // hostname is another site (M21 B1, closes M20 Errata 2). `Host: box:80` vs
          // `Origin: http://box` refuses — URL drops the default port, the header kept it — a
          // shape no browser produces, fail-closed.
          sameSide = request.host !== null && originHost === request.host.toLowerCase()
          break
        default:
          assertNever(request.mode)
      }
    }
    if (!sameSide) return refused(`cross-origin request refused (origin: ${request.origin})`)
  }
  return null
}

export function boundaryVerdict(request: BoundaryRequest): BoundaryVerdict {
  const host = request.host === null ? null : hostOf(request.host)

  // Rule 1 — loopback mode, every path, every method: both loopback spellings and the IPv6
  // loopback are the only hosts this instance answers as.
  switch (request.mode) {
    case 'loopback-only':
      if (host === null || !ALLOWED_HOSTS.has(host)) {
        return refused(`foreign host ${host ?? '<none>'} — this instance is loopback-only`)
      }
      break
    case 'password':
      // Skipped: the defence is the credential now, and answering to a tailnet hostname is the point.
      break
    default:
      assertNever(request.mode)
  }

  // Rule 3 runs before rule 2's public-path allow so that the login POST — public, but an
  // /api/ write — is still refused cross-site. Outcomes match the spec's order exactly.
  const isApi = request.path.startsWith('/api/')
  if (isApi) {
    const objection = crossSiteRefusal(request)
    if (objection !== null) return objection
  }

  // Rule 2 — public paths need no credential in either mode.
  if (PUBLIC_PATHS.has(request.path) || request.path.startsWith(PUBLIC_PREFIX)) return { allow: true }

  // Rule 4 — password mode: a session opens every path, a bearer opens /api/ only. M15's
  // "neither header — a local process is the operator" escape hatch is closed here: no
  // credential is nobody, full stop. It stays open in loopback mode (rule 5).
  switch (request.mode) {
    case 'password':
      if (request.sessionValid) return { allow: true }
      if (isApi && request.bearerValid) return { allow: true }
      return { allow: false, kind: 'unauthenticated', reason: 'authentication required' }
    case 'loopback-only':
      break
    default:
      assertNever(request.mode)
  }

  // Rule 5 — loopback mode, nothing objected: curl, scripts, the gate, the operator's browser.
  return { allow: true }
}
