import { describe, expect, it } from 'vitest'
import { feedSummary } from '../src/lib/feedSummary.js'
import { readableEventType } from '../src/lib/eventLabels.js'

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

  // M44 R5/R8: this fallback used to be the bare dotted type, which is what put `run.started` in
  // the Overview page's `live events` panel. `gate:m44-ux-foundation`'s stage 4 read it back off
  // the real page and failed on it.
  it('falls back to the event type SAID OUT LOUD for any other event type', () => {
    expect(feedSummary('run.failed', { reason: 'boom' })).toBe('Runs · failed')
    expect(feedSummary('task.dependency_added', {})).toBe('Tasks · dependency added')
  })

  it('falls back the same way when the payload does not match the expected shape', () => {
    expect(feedSummary('run.tool_call', {})).toBe('Runs · tool call')
    expect(feedSummary('run.output', { text: 42 })).toBe('Runs · output')
  })
})

describe('readableEventType', () => {
  it('names the family from the prefix table and de-underscores the rest', () => {
    expect(readableEventType('run.started')).toBe('Runs · started')
    expect(readableEventType('task.created')).toBe('Tasks · created')
    expect(readableEventType('slave.message_reassigned')).toBe('Messages · message reassigned')
    expect(readableEventType('workspace.goal_set')).toBe('Project · goal set')
    expect(readableEventType('supervisor.decided')).toBe('Supervisor · decided')
  })

  // A PROJECTION, not a table (erratum E5 declined a per-type table): a family nobody has named
  // falls back to its own prefix rather than rendering `undefined`, and the result still carries
  // no underscore for a reader to decode.
  it('never renders undefined for a family the table does not know', () => {
    expect(readableEventType('nothing.at_all')).toBe('nothing · at all')
    expect(readableEventType('bare_word')).toBe('bare word')
  })
})
