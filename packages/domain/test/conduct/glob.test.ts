import { describe, expect, it } from 'vitest'
import { globToRegExp, isValidOwnedGlob } from '../../src/conduct/glob.js'

const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path)

describe('globToRegExp', () => {
  it('matches ** at any depth including zero', () => {
    expect(matches('src/**', 'src/a.ts')).toBe(true)
    expect(matches('src/**', 'src/x/y/a.ts')).toBe(true)
    expect(matches('src/**/a.ts', 'src/a.ts')).toBe(true)
    expect(matches('**', 'README.md')).toBe(true)
    expect(matches('src/**', 'srcx/a.ts')).toBe(false)
  })

  it('keeps * and ? inside one segment and escapes regex characters', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matches('src/*.ts', 'src/x/a.ts')).toBe(false)
    expect(matches('a?.py', 'ab.py')).toBe(true)
    expect(matches('a+b(c).py', 'a+b(c).py')).toBe(true)
    expect(matches('a.py', 'axpy')).toBe(false)
  })

  it('reads a trailing slash as the whole directory', () => {
    expect(matches('docs/', 'docs/x/y.md')).toBe(true)
    expect(matches('docs/', 'docs')).toBe(false)
  })
})

describe('isValidOwnedGlob', () => {
  it('refuses absolute, parent, empty and backslash paths', () => {
    expect(isValidOwnedGlob('src/**')).toBe(true)
    expect(isValidOwnedGlob('/etc/**')).toBe(false)
    expect(isValidOwnedGlob('src/../x')).toBe(false)
    expect(isValidOwnedGlob('')).toBe(false)
    expect(isValidOwnedGlob('src\\a')).toBe(false)
  })
})
