import { describe, expect, it } from 'vitest'
import { executionEventSchema } from '../../src/events/schema.js'
import { LANE_BY_TYPE } from '../../src/supervisor/timeline.js'

const BASE = { seq: 1, ts: '2026-10-02T09:00:00.000Z', workspaceId: 'w1', taskId: 't1', slaveId: 's1', actor: 'human' } as const
const closed = (payload: object) => executionEventSchema.safeParse({ ...BASE, type: 'slave.question_closed', payload }).success

describe('slave.question_closed (human cards H1)', () => {
  it('reads a close with every reason, and a null decision and note', () => {
    for (const reason of ['answered', 'decided', 'dismissed', 'timed_out', 'superseded']) {
      expect(closed({ messageId: 'm1', reason, by: 'u1', decisionId: null, note: null })).toBe(true)
    }
  })

  it('refuses an unknown reason and a note over 500 characters', () => {
    expect(closed({ messageId: 'm1', reason: 'forgotten', by: 'u1', decisionId: null, note: null })).toBe(false)
    expect(closed({ messageId: 'm1', reason: 'dismissed', by: 'u1', decisionId: 'd1', note: 'x'.repeat(501) })).toBe(false)
  })

  it('reads a person as a hand-off source', () => {
    const payload = { version: 1, handOffId: 'h1', source: 'person', fromPackage: null, toPackage: 'skeleton', path: null, package: 'skeleton', delivery: 'rework', change: 'add a start script' }
    expect(executionEventSchema.safeParse({ ...BASE, type: 'workspace.package_handed_off', payload }).success).toBe(true)
  })

  it('files the close on the work lane', () => {
    expect(LANE_BY_TYPE['slave.question_closed']).toBe('work')
  })
})

describe('workspace.package_noted (human cards plan B D9)', () => {
  const noted = (payload: object) => executionEventSchema.safeParse({ ...BASE, actor: 'slave', type: 'workspace.package_noted', payload }).success
  const note = { version: 1, packageKey: 'identity-access', runId: 'r1', note: 'VENDOR_LICENSE_PUBLIC_KEYS is a placeholder.' }

  it('reads a note, and refuses one over 1000 characters, an empty one, a long package key and a version 0', () => {
    expect(noted(note)).toBe(true)
    expect(noted({ ...note, note: 'x'.repeat(1000) })).toBe(true)
    expect(noted({ ...note, note: 'x'.repeat(1001) })).toBe(false)
    expect(noted({ ...note, note: '' })).toBe(false)
    expect(noted({ ...note, packageKey: 'k'.repeat(41) })).toBe(false)
    expect(noted({ ...note, version: 0 })).toBe(false)
  })

  it('files a note on the work lane, beside the hand-offs', () => {
    expect(LANE_BY_TYPE['workspace.package_noted']).toBe('work')
  })
})
