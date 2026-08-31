import { describe, expect, it } from 'vitest'
import { CLAUDE_SUMMARY_ARG_KEYS, CURSOR_SUMMARY_ARG_KEYS, isRecord, summaryFor } from '../src/runtime/summary.js'

describe('isRecord (characterization)', () => {
  it('accepts plain objects', () => { expect(isRecord({ a: 1 })).toBe(true) })
  it('rejects null, arrays and primitives', () => {
    expect(isRecord(null)).toBe(false)
    // summary.ts:1-3's guard is `typeof value === 'object' && value !== null && !Array.isArray(value)` --
    // arrays are excluded explicitly, not just by the bare typeof-and-not-null check.
    expect(isRecord([1])).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(7)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

describe('summaryFor (characterization)', () => {
  it('the two key tables are distinct on purpose (M13 Task 5 — never merge them)', () => {
    expect(CURSOR_SUMMARY_ARG_KEYS).toEqual(['path', 'command'])
    expect(CLAUDE_SUMMARY_ARG_KEYS[0]).toBe('skill')
    expect([...CLAUDE_SUMMARY_ARG_KEYS]).not.toEqual([...CURSOR_SUMMARY_ARG_KEYS])
  })
  it('picks the first present key from the table', () => {
    expect(summaryFor('Shell', { command: 'ls -la' }, CURSOR_SUMMARY_ARG_KEYS)).toContain('ls -la')
  })
  it('falls back to the bare tool name for unusable args', () => {
    expect(summaryFor('Mystery', null, CURSOR_SUMMARY_ARG_KEYS)).toContain('Mystery')
  })

  // --- crib'd from stream.test.ts:170-234, exercising summaryFor directly rather than through parseStreamLine ---

  it('derives the summary from file_path for a Write tool_use', () => {
    expect(summaryFor('Write', { file_path: '/abs/note3.txt', content: 'hi' }, CLAUDE_SUMMARY_ARG_KEYS)).toBe(
      'Write /abs/note3.txt',
    )
  })

  it('collapses whitespace in a multiline command and truncates it at 80 chars with an ellipsis', () => {
    const command = `ls -la\t\t\n\n${'x'.repeat(90)}`
    const expectedArg = `ls -la ${'x'.repeat(73)}…`
    expect(expectedArg.length).toBe(81) // 80 chars of arg + the appended ellipsis
    expect(summaryFor('Bash', { command }, CLAUDE_SUMMARY_ARG_KEYS)).toBe(`Bash ${expectedArg}`)
  })

  it('returns the bare tool name when args is undefined', () => {
    expect(summaryFor('TodoWrite', undefined, CLAUDE_SUMMARY_ARG_KEYS)).toBe('TodoWrite')
  })

  it('returns the bare tool name when the known argument keys hold only non-string values', () => {
    expect(
      summaryFor('Read', { file_path: 42, path: null, command: ['echo'] }, CLAUDE_SUMMARY_ARG_KEYS),
    ).toBe('Read')
  })

  it('tolerates a malformed (non-object) args value rather than throwing', () => {
    expect(summaryFor('Grep', 'not-an-object', CLAUDE_SUMMARY_ARG_KEYS)).toBe('Grep')
  })
})
