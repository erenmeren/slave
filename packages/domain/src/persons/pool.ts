/**
 * Managed-pool identity primitives for the Catalog Person Pool feature.
 *
 * A "managed person" is one of exactly three people created per active SlaveTemplate
 * (poolSlot 1, 2, 3). This module supplies the English-name generator/validator that
 * later control code uses when creating those people. Names are NOT persisted here --
 * the control layer owns database uniqueness and retry logic.
 *
 * Randomness is injectable so unit tests are deterministic; production callers pass
 * no argument and get cryptographic randomness via the default.
 */

/** English first-name vocabulary. Bounded so callers can reason about retry capacity. */
export const FIRST_NAMES: readonly string[] = [
  'Alice',
  'Arthur',
  'Benjamin',
  'Charlotte',
  'Clara',
  'Daniel',
  'Diana',
  'Edward',
  'Eleanor',
  'Elijah',
  'Emily',
  'Emma',
  'Ethan',
  'Evelyn',
  'Florence',
  'George',
  'Grace',
  'Hannah',
  'Harper',
  'Henry',
  'Isabella',
  'James',
  'Jane',
  'Joseph',
  'Julian',
  'Katherine',
  'Leo',
  'Liam',
  'Lily',
  'Lucy',
  'Margaret',
  'Mason',
  'Matthew',
  'Mia',
  'Nathan',
  'Noah',
  'Nora',
  'Oliver',
  'Olivia',
  'Owen',
  'Penelope',
  'Peter',
  'Phoebe',
  'Rose',
  'Samuel',
  'Sophia',
  'Thomas',
  'Victoria',
  'William',
  'Zoe',
] as const

/** English surname vocabulary. Bounded so callers can reason about retry capacity. */
export const LAST_NAMES: readonly string[] = [
  'Adams',
  'Baker',
  'Bennett',
  'Brooks',
  'Carter',
  'Clark',
  'Collins',
  'Cooper',
  'Davis',
  'Edwards',
  'Evans',
  'Foster',
  'Garcia',
  'Gray',
  'Green',
  'Hall',
  'Harris',
  'Hill',
  'Hughes',
  'Jackson',
  'Johnson',
  'Jones',
  'Kelly',
  'King',
  'Lee',
  'Lewis',
  'Martin',
  'Martinez',
  'Miller',
  'Mitchell',
  'Moore',
  'Morgan',
  'Morris',
  'Murphy',
  'Nelson',
  'Parker',
  'Patel',
  'Phillips',
  'Price',
  'Richardson',
  'Roberts',
  'Robinson',
  'Rogers',
  'Scott',
  'Smith',
  'Stewart',
  'Taylor',
  'Thomas',
  'Thompson',
  'Turner',
  'Walker',
  'Watson',
  'White',
  'Williams',
  'Wilson',
  'Wood',
  'Wright',
  'Young',
] as const

/**
 * Unbiased index via rejection sampling.
 *
 * Modulo reduction (`v % n`) is biased when `2^32` is not divisible by `n`: the
 * first `(2^32 % n)` remainders are drawn one extra time. Rejection sampling
 * eliminates the bias by discarding any Uint32 that falls in the "tail"
 * `[limit, 2^32)` where `limit = 2^32 − (2^32 % n)`, then reducing the accepted
 * value. The expected number of draws is less than 2 for all `n ≤ 2^31`.
 *
 * Exported as a pure seam so tests can verify retry behaviour by injecting a
 * controlled `getUint32` sequence — no mock of `crypto` needed, and no
 * test-only production API.
 */
export function unbiasedIndex(getUint32: () => number, upperExclusive: number): number {
  // 4294967296 = 2^32, safely representable as a JS number (< 2^53 − 1).
  const limit = 4294967296 - (4294967296 % upperExclusive)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = getUint32()
    if (v < limit) return v % upperExclusive
  }
}

/** Cryptographic random index using rejection sampling, used as the production default. */
function cryptoRandomIndex(upperExclusive: number): number {
  const array = new Uint32Array(1)
  return unbiasedIndex(() => {
    crypto.getRandomValues(array)
    // biome-ignore lint/style/noNonNullAssertion: array always has one element
    return array[0]!
  }, upperExclusive)
}

/**
 * Generate a random English name: one first name and one surname from the bounded
 * dictionaries, separated by exactly one space.
 *
 * @param randomIndex - injectable randomness; defaults to cryptographic random.
 *   Called with the upper-exclusive bound and must return an integer in [0, bound).
 */
export function randomEnglishName(
  randomIndex: (upperExclusive: number) => number = cryptoRandomIndex,
): string {
  const first = FIRST_NAMES[randomIndex(FIRST_NAMES.length)]
  const last = LAST_NAMES[randomIndex(LAST_NAMES.length)]
  return `${first} ${last}`
}

const FIRST_NAME_SET = new Set<string>(FIRST_NAMES)
const LAST_NAME_SET = new Set<string>(LAST_NAMES)

/**
 * Return true iff `value` is a string that could have been produced by
 * {@link randomEnglishName}: exactly two words separated by one space, where
 * the first word is in {@link FIRST_NAMES} and the second is in {@link LAST_NAMES}.
 */
export function isGeneratedEnglishName(value: string): boolean {
  const spaceIndex = value.indexOf(' ')
  if (spaceIndex === -1) return false
  const first = value.slice(0, spaceIndex)
  const last = value.slice(spaceIndex + 1)
  // Ensure there is exactly one space (no double spaces, no trailing spaces)
  if (last.includes(' ')) return false
  return FIRST_NAME_SET.has(first) && LAST_NAME_SET.has(last)
}
