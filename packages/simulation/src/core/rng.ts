/** mulberry32, written as a pure step: the state is a 32-bit integer the caller carries. The
 *  engine keeps it in `EngineState.rngState` so a persisted run resumes its sequence exactly. */
export function seedState(seed: number): number {
  return seed >>> 0
}

export function nextRandom(state: number): { readonly value: number; readonly state: number } {
  let a = (state + 0x6d2b79f5) >>> 0
  let t = a
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return { value, state: a }
}
