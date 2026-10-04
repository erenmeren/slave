import { describe, expect, it } from 'vitest'
import { executionEventSchema } from '../../src/events/schema.js'
import { LANE_BY_TYPE } from '../../src/supervisor/timeline.js'
import { SITUATION_KINDS } from '../../src/supervisor/situations.js'
import { LEAD_SITUATION_KINDS } from '../../src/lead/constants.js'

const BASE = { seq: 1, ts: '2026-10-04T09:00:00.000Z', workspaceId: 'w1', actor: 'system' } as const
const parses = (type: string, payload: object): boolean => executionEventSchema.safeParse({ ...BASE, type, payload }).success

describe('lead-flow events', () => {
  it('reads a state change with a stop reason or none', () => {
    expect(parses('workspace.lead_state', { version: 1, state: 'building', reason: null })).toBe(true)
    expect(parses('workspace.lead_state', { version: 1, state: 'awaiting_decision', reason: 'no_progress' })).toBe(true)
    expect(parses('workspace.lead_state', { version: 1, state: 'hunting', reason: null })).toBe(false)
    expect(parses('workspace.lead_state', { version: 1, state: 'stopped', reason: 'because' })).toBe(false)
  })

  it('reads a note, and refuses an unknown kind, an empty detail and one over 500 characters', () => {
    expect(parses('workspace.lead_noted', { version: 2, kind: 'turn', detail: 'turn 2 (rework): the same session was resumed', runId: 'r1' })).toBe(true)
    expect(parses('workspace.lead_noted', { version: 2, kind: 'limit_wait', detail: 'the provider refused the turn', runId: null })).toBe(true)
    expect(parses('workspace.lead_noted', { version: 2, kind: 'gossip', detail: 'x', runId: null })).toBe(false)
    expect(parses('workspace.lead_noted', { version: 2, kind: 'turn', detail: '', runId: null })).toBe(false)
    expect(parses('workspace.lead_noted', { version: 2, kind: 'turn', detail: 'x'.repeat(501), runId: null })).toBe(false)
  })

  it('files both on the work lane', () => {
    expect(LANE_BY_TYPE['workspace.lead_state']).toBe('work')
    expect(LANE_BY_TYPE['workspace.lead_noted']).toBe('work')
  })

  it('names only situations the Supervisor knows (LEAD_SITUATION_KINDS is spelled as strings)', () => {
    const known: readonly string[] = SITUATION_KINDS
    for (const kind of LEAD_SITUATION_KINDS) expect(known).toContain(kind)
  })
})
