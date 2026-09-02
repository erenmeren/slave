import { describe, expect, it } from 'vitest'
import { safeNext } from '../src/lib/safeNext.js'

describe('safeNext', () => {
  it.each([
    ['/w/abc/tasks', '/w/abc/tasks'],
    ['/w/abc/tasks?tab=done', '/w/abc/tasks?tab=done'],
    ['/', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['w/abc', '/'],
    ['', '/'],
    [null, '/'],
  ])('%j → %s', (value, expected) => {
    expect(safeNext(value)).toBe(expected)
  })
})
