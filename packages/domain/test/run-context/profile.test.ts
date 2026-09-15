import { describe, expect, it } from 'vitest'
import { PROFILE_MAX_CHARS } from '../../src/run-context/profile.js'

/**
 * M58 R7: the CHAIN moved to `packages/domain/src/persons/overrides.ts` and is proved by
 * `packages/domain/test/persons/overrides.test.ts` -- three levels now, and one ladder for the
 * profile, the model and the provider. What is left here is the cap, which is what this file's two
 * enforcement points (`setProfile` and `buildRunContext`) actually share.
 */
describe('PROFILE_MAX_CHARS', () => {
  it('is the one definition of the cap both enforcement points read', () => {
    expect(PROFILE_MAX_CHARS).toBe(48_000)
  })
})
