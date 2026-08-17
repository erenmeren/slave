import { describe, expect, it } from 'vitest'
import { DOMAIN_VERSION } from '../src/index.js'

describe('domain package', () => {
  it('exposes a version constant', () => {
    expect(DOMAIN_VERSION).toBe('1')
  })
})
