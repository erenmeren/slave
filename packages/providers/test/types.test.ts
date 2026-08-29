import { describe, expect, it } from 'vitest'
import { PROVIDER_KINDS } from '../src/index.js'

describe('PROVIDER_KINDS', () => {
  // The real guard against a missing/extra member is compile-time (`types.ts`'s
  // `_ProviderKindsComplete`, mirroring `capabilities.ts`'s `const unhandled: never`): adding a
  // third `ProviderKind` without a matching entry fails `tsc`, not this test. This pins the
  // CONTENT so a change to the list is a change a reviewer sees in a diff, the same reason
  // `capabilities.test.ts` asserts `Object.keys(caps).sort()` rather than trusting the type alone.
  it('is exactly the two configured provider kinds', () => {
    expect(PROVIDER_KINDS).toEqual(['claude_code', 'cursor'])
  })
})
