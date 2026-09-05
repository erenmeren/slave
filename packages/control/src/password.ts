/**
 * Local-account passwords, PBKDF2-SHA256 on Web Crypto only (`globalThis.crypto.subtle`) -- no
 * `node:crypto` in `packages/control/src` (M23 F2/F3). 600,000 iterations is OWASP's current
 * floor for PBKDF2-SHA256; the stored format carries the iteration count so a future bump can
 * raise it without breaking verification of hashes written under the old count.
 */

const ITERATIONS = 600_000
const KEY_BYTES = 32
const encoder = new TextEncoder()
const subtle = globalThis.crypto.subtle

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Array.from(view, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Not secret-independent by design for LENGTH -- `stored`'s length is public (it is what got
 * written to the database) -- only the VALUE being compared is timing-sensitive. XORing every
 * byte rather than short-circuiting on the first mismatch is what keeps the compare itself from
 * leaking how much of the candidate matched.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.min(a.length, b.length)
  let diff = a.length === b.length ? 0 : 1
  for (let i = 0; i < length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export async function hashWithSalt(password: string, salt: Uint8Array<ArrayBuffer>, iterations = ITERATIONS): Promise<string> {
  const key = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BYTES * 8)
  return `pbkdf2-sha256$${iterations}$${hex(salt)}$${hex(bits)}`
}

export async function hashPassword(password: string): Promise<string> {
  return hashWithSalt(password, globalThis.crypto.getRandomValues(new Uint8Array(16)))
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationsText, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'pbkdf2-sha256' || iterationsText === undefined || saltHex === undefined || hashHex === undefined) {
    return false
  }
  const iterations = Number(iterationsText)
  if (!Number.isInteger(iterations) || iterations < 1) return false
  const candidate = await hashWithSalt(password, fromHex(saltHex), iterations)
  return constantTimeEqual(candidate, stored)
}

/**
 * A real hash of a random secret, so a missing user costs the same derivation as a wrong
 * password -- `verifyCredentials` in `users.ts` awaits this instead of skipping the derivation
 * when `username` matches no row.
 *
 * Lazy and memoized (CONTROLLER RULING): a module-level `DUMMY_HASH` promise would compute a
 * 600k-iteration derivation the moment anything imports `@slave-of-ai/control` -- the daemon, the
 * CLI, the web server -- whether or not a login ever happens. Deferring to first call, and
 * memoizing so every subsequent missing-user login reuses the same hash rather than re-deriving,
 * keeps that cost off every import path but still off every request after the first.
 */
let dummy: Promise<string> | null = null
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(hex(globalThis.crypto.getRandomValues(new Uint8Array(16))))
  return dummy
}
