/**
 * The session (M20 spec §2.2): a stateless, HMAC-signed cookie. No table, no store — changing
 * the password invalidates every session at once, which is the revocation story for one
 * operator. Web Crypto ONLY: the middleware runs on Next's edge runtime, the routes on Node,
 * vitest on Node, and this one module must serve all three (the built-in Node crypto module is
 * banned in `apps/web/src`). Pure: the password arrives as an argument; nothing here reads the env.
 */
export const SESSION_COOKIE = 'aiteamos_session'
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

const encoder = new TextEncoder()

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(text))
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Constant-time equality for credentials. Neither runtime offers `timingSafeEqual` on the edge,
 *  so both sides are hashed first (which makes a length difference irrelevant) and the two
 *  digests are compared with a loop that never short-circuits. EVERY credential comparison in
 *  this app goes through here — the login route's password check, the bearer, the signature. */
export async function digestEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)])
  const left = new Uint8Array(da)
  const right = new Uint8Array(db)
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return diff === 0
}

/** Derived, not random, on purpose: a per-boot random key would log the operator out on every
 *  restart, and anyone who knows the password already holds the stronger credential. */
async function sessionKey(password: string): Promise<CryptoKey> {
  const raw = await sha256(`aiteamos-session:v1:${password}`)
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function sign(password: string, expiresAt: number): Promise<string> {
  const key = await sessionKey(password)
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(expiresAt))))
}

/** The cookie value: `<expiresAt unix seconds>.<hex hmac>`. */
export async function mintSession(password: string, now: Date): Promise<string> {
  const expiresAt = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS
  return `${String(expiresAt)}.${await sign(password, expiresAt)}`
}

/** `null`, a value without exactly one dot, a non-integer expiry, an expiry at or before `now`,
 *  or a signature that does not match → false. */
export async function verifySession(password: string, value: string | null, now: Date): Promise<boolean> {
  if (value === null) return false
  const parts = value.split('.')
  const expiryText = parts[0]
  const signature = parts[1]
  if (parts.length !== 2 || expiryText === undefined || signature === undefined) return false
  if (!/^\d{1,12}$/.test(expiryText) || signature.length === 0) return false
  const expiresAt = Number(expiryText)
  if (expiresAt <= Math.floor(now.getTime() / 1000)) return false
  return digestEqual(signature, await sign(password, expiresAt))
}

/** `Authorization: Bearer <password>` — one space, case-sensitive scheme, the exact token. */
export async function verifyBearer(password: string, authorization: string | null): Promise<boolean> {
  if (authorization === null || !authorization.startsWith('Bearer ')) return false
  const token = authorization.slice('Bearer '.length)
  if (token.length === 0 || token.startsWith(' ')) return false
  return digestEqual(token, password)
}

/** The Set-Cookie value for a session, or — with `null` — the one that clears it. `SameSite=Lax`
 *  rather than `Strict` so a link opened from another app lands logged in; the boundary's
 *  cross-site rule already covers the CSRF case Lax leaves open. */
export function sessionCookieHeader(value: string | null, options: { readonly secure: boolean }): string {
  const attributes = [
    `${SESSION_COOKIE}=${value ?? ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(value === null ? 0 : SESSION_TTL_SECONDS)}`,
  ]
  if (options.secure) attributes.push('Secure')
  return attributes.join('; ')
}

/** Whether the cookie may carry `Secure`: the request's own scheme, or a proxy's word for it. */
export function requestIsHttps(request: Request): boolean {
  return new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https'
}
