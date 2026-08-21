import { describe, expect, it } from 'vitest'
import { feedSummary } from '../src/lib/feedSummary.js'

describe('feedSummary', () => {
  it("summarizes run.tool_call with its payload's summary", () => {
    expect(feedSummary('run.tool_call', { name: 'Write', summary: 'Write note.txt' })).toBe('Write note.txt')
  })

  it('truncates run.output text to the first 80 characters', () => {
    const text = 'x'.repeat(200)
    const summary = feedSummary('run.output', { text })
    expect(summary).toBe('x'.repeat(80))
    expect(summary.length).toBe(80)
  })

  it('falls back to the bare type for any other event type', () => {
    expect(feedSummary('run.failed', { reason: 'boom' })).toBe('run.failed')
  })

  it('falls back to the bare type when the payload does not match the expected shape', () => {
    expect(feedSummary('run.tool_call', {})).toBe('run.tool_call')
    expect(feedSummary('run.output', { text: 42 })).toBe('run.output')
  })
})
