/**
 * The session (M23 spec §7 F4): a stateless, HMAC-signed cookie that NAMES ITS USER. No table, no
 * store — rotating `AITEAMOS_SESSION_SECRET` invalidates every session at once, and deleting a
 * user is caught one layer up (`server/principal.ts` asks the database whether the id in the
 * cookie still exists). Web Crypto ONLY: the middleware runs on Next's edge runtime, the routes on
 * Node, vitest on Node, and this one module must serve all three (the built-in Node crypto module
 * is banned in `apps/web/src`). Pure: the secret arrives as an argument; nothing here reads the env.
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
 *  this file goes through here — with the cookie's signature now the only caller, since M23
 *  moved the password comparison into `packages/control/src/password.ts`'s own constant-time check. */
export async function digestEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)])
  const left = new Uint8Array(da)
  const right = new Uint8Array(db)
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return diff === 0
}

/** The signing key is the secret's UTF-8 bytes, used raw: `AITEAMOS_SESSION_SECRET` is already
 *  32+ random characters (`openssl rand -hex 32`), so a derivation step would add cost without
 *  adding entropy. Not per-boot random, on purpose: a fresh key every restart would log every
 *  device out on every `next dev` reload. */
async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

/** The signature covers BOTH halves of the payload, `"<userId>.<expiresAt>"` — so neither the
 *  identity nor the expiry can be edited without invalidating the cookie. */
async function sign(secret: string, userId: string, expiresAt: number): Promise<string> {
  const key = await sessionKey(secret)
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${userId}.${String(expiresAt)}`)))
}

/** The set of characters a user id may use inside the cookie: the dot is the separator, so an id
 *  carrying one would split the value apart. Prisma's `@default(uuid())` is well inside this. */
const USER_ID_RE = /^[A-Za-z0-9-]{1,64}$/

/** The cookie value: `<userId>.<expiresAt unix seconds>.<hex hmac>`. */
export async function mintSession(secret: string, userId: string, now: Date): Promise<string> {
  const expiresAt = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS
  return `${userId}.${String(expiresAt)}.${await sign(secret, userId, expiresAt)}`
}

/** The user the cookie names, or `null`: no cookie, a value without exactly two dots, a user id
 *  outside `USER_ID_RE`, a non-integer expiry, an expiry at or before `now`, or a signature that
 *  does not match. Stateless — whether that user still EXISTS is `server/principal.ts`'s question. */
export async function verifySession(secret: string, value: string | null, now: Date): Promise<{ userId: string } | null> {
  if (value === null) return null
  const parts = value.split('.')
  const userId = parts[0]
  const expiryText = parts[1]
  const signature = parts[2]
  if (parts.length !== 3 || userId === undefined || expiryText === undefined || signature === undefined) return null
  if (!USER_ID_RE.test(userId) || !/^\d{1,12}$/.test(expiryText) || signature.length === 0) return null
  const expiresAt = Number(expiryText)
  if (expiresAt <= Math.floor(now.getTime() / 1000)) return null
  return (await digestEqual(signature, await sign(secret, userId, expiresAt))) ? { userId } : null
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
