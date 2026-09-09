/**
 * The 64 round constants of SHA-256 (FIPS 180-4 §4.2.2): the first 32 bits of the fractional parts
 * of the cube roots of the first 64 primes.
 */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** The eight initial hash words (FIPS 180-4 §5.3.3): fractional parts of the square roots of the
 *  first eight primes. */
const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const

const rotr = (word: number, bits: number): number => ((word >>> bits) | (word << (32 - bits))) >>> 0

/**
 * SHA-256 of a UTF-8 string, lowercase hex.
 *
 * **Why this is hand-rolled rather than `node:crypto`.** `packages/domain` is imported by
 * `apps/web`'s CLIENT bundle -- `SupervisorPanel.tsx` is a `'use client'` file and imports
 * `PROFILE_MAX_CHARS`, a VALUE, from this package's index, which pulls the whole index graph into
 * webpack's browser build. A `node:crypto` import anywhere in that graph fails `npm run web:build`
 * outright ("Reading from \"node:crypto\" is not handled by plugins"), measured on this exact tree
 * before this file was written. The domain has no Node built-in import today and this is not the
 * milestone to give it its first one; `apps/orchestrator` and `packages/control` keep their own
 * `createHash` one-liners, which is why the hash they compute has to agree with this one -- the
 * test cross-checks every case against `node:crypto` so a drift is a failing test, not a silently
 * wrong `GoalVersion.sha256`.
 *
 * FIPS 180-4, the textbook block loop. `TextEncoder` is a global in Node and in every browser, so
 * this file imports nothing at all.
 */
export function goalSha256(text: string): string {
  const bytes = new TextEncoder().encode(text)
  // One 0x80 byte, then zeroes, then a 64-bit big-endian bit length -- rounded up to whole
  // 64-byte blocks. `(len + 8) >> 6` counts the blocks the message plus the length field fills
  // before padding; the `+ 1` is the block the 0x80 always needs.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const bitLength = bytes.length * 8
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const state = Uint32Array.from(INITIAL_STATE)
  const schedule = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) schedule[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const x = schedule[i - 15] as number
      const y = schedule[i - 2] as number
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0
      schedule[i] = ((schedule[i - 16] as number) + s0 + (schedule[i - 7] as number) + s1) >>> 0
    }

    let a = state[0] as number
    let b = state[1] as number
    let c = state[2] as number
    let d = state[3] as number
    let e = state[4] as number
    let f = state[5] as number
    let g = state[6] as number
    let h = state[7] as number

    for (let i = 0; i < 64; i += 1) {
      const sigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const choose = ((e & f) ^ (~e & g)) >>> 0
      const temp1 = (h + sigma1 + choose + (ROUND_CONSTANTS[i] as number) + (schedule[i] as number)) >>> 0
      const sigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const temp2 = (sigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    state[0] = ((state[0] as number) + a) >>> 0
    state[1] = ((state[1] as number) + b) >>> 0
    state[2] = ((state[2] as number) + c) >>> 0
    state[3] = ((state[3] as number) + d) >>> 0
    state[4] = ((state[4] as number) + e) >>> 0
    state[5] = ((state[5] as number) + f) >>> 0
    state[6] = ((state[6] as number) + g) >>> 0
    state[7] = ((state[7] as number) + h) >>> 0
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('')
}

/** The added and removed lines between two goal texts (M40 §3). */
export interface GoalDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

/**
 * Every non-blank line of the text, trimmed. Blank lines are dropped rather than diffed: a goal
 * gains and loses paragraph breaks constantly and "an empty line was added" is not something a
 * human reading a goal history wants told.
 */
function meaningfulLines(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * What changed between two goal versions, line by line (M40 §3) -- the web history view's diff and
 * nothing more ambitious: a SET difference over trimmed lines, not a Myers diff, so a line that
 * merely MOVED shows in neither list.
 *
 * Order is the order the lines appear in the text they came from (`added` reads in `next`'s order,
 * `removed` in `previous`'s), which is what makes the rendered diff read like the goal rather than
 * like a hash bucket. Repeats collapse: a line added twice is one addition, because a set
 * difference is what this is.
 */
export function goalDiff(previous: string, next: string): GoalDiff {
  const before = meaningfulLines(previous)
  const after = meaningfulLines(next)
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: [...new Set(after.filter((line) => !beforeSet.has(line)))],
    removed: [...new Set(before.filter((line) => !afterSet.has(line)))],
  }
}
