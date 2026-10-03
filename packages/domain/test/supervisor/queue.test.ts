import { describe, expect, it } from 'vitest'
import { BLOCKING_SITUATION_KINDS, buildQueue, groupKeyFor, versionOfSubject } from '../../src/supervisor/queue.js'

describe('the queue (human cards H4)', () => {
  it("groups a question by the question, a task's cards and the blocked task by the task", () => {
    expect(groupKeyFor({ kind: 'decision', situationKind: 'conductor_question', subjectId: 'm1', taskId: null })).toBe('question:m1')
    expect(groupKeyFor({ kind: 'question', situationKind: null, subjectId: 'm1', taskId: 't1' })).toBe('question:m1')
    expect(groupKeyFor({ kind: 'decision', situationKind: 'task_failed', subjectId: 't1', taskId: 't1' })).toBe('task:t1')
    expect(groupKeyFor({ kind: 'blocked_task', situationKind: null, subjectId: 't1', taskId: 't1' })).toBe('task:t1')
    expect(groupKeyFor({ kind: 'integrate', situationKind: null, subjectId: 't1', taskId: 't1' })).toBe('task:t1')
    expect(groupKeyFor({ kind: 'decision', situationKind: 'goal_needs_human', subjectId: 'ws:v2', taskId: null })).toBe('goal_needs_human:ws:v2')
    // A card about a run names its task in its facts, but it is about the run, not the task.
    expect(groupKeyFor({ kind: 'decision', situationKind: 'run_looping', subjectId: 'r1', taskId: 't1' })).toBe('run_looping:r1')
    expect(versionOfSubject('ws-1:v2:r3')).toBe(2)
    expect(versionOfSubject('ws-1:v12:merge')).toBe(12)
    expect(versionOfSubject('ws-1:v3')).toBe(3)
    expect(versionOfSubject('m1')).toBeNull()
    expect(versionOfSubject('slave-1:bash')).toBeNull()
  })

  it('names exactly the two situations that block a version on their own', () => {
    expect([...BLOCKING_SITUATION_KINDS]).toEqual(['goal_needs_human', 'task_blocked_human'])
  })

  it('lists the newest version first, what blocks it first, merges one subject, and puts project items last', () => {
    const groups = buildQueue([
      { id: 'a', groupKey: 'question:m0', goalVersion: 1, blocking: false, since: '2026-10-03T08:00:00.000Z', decision: true },
      { id: 'b', groupKey: 'task:t1', goalVersion: 2, blocking: false, since: '2026-10-03T08:10:00.000Z', decision: false },
      { id: 'c', groupKey: 'task:t1', goalVersion: 2, blocking: true, since: '2026-10-03T08:20:00.000Z', decision: true },
      { id: 'd', groupKey: 'question:m2', goalVersion: 2, blocking: true, since: '2026-10-03T08:05:00.000Z', decision: true },
      { id: 'e', groupKey: 'no_reviewer:reviewer', goalVersion: null, blocking: false, since: '2026-10-03T07:00:00.000Z', decision: true },
    ])
    expect(groups.map((g) => [g.goalVersion, g.key, g.blocking, g.ids])).toEqual([
      [2, 'question:m2', true, ['d']],
      // Pre-flight F27: the head is the group's decision (c), not its oldest item (b).
      [2, 'task:t1', true, ['c', 'b']],
      [1, 'question:m0', false, ['a']],
      [null, 'no_reviewer:reviewer', false, ['e']],
    ])
  })

  it('heads a group with its oldest decision, else its oldest item', () => {
    const groups = buildQueue([
      { id: 'task', groupKey: 'task:t1', goalVersion: 1, blocking: true, since: '2026-10-03T07:00:00.000Z', decision: false },
      { id: 'late', groupKey: 'task:t1', goalVersion: 1, blocking: false, since: '2026-10-03T09:00:00.000Z', decision: true },
      { id: 'early', groupKey: 'task:t1', goalVersion: 1, blocking: false, since: '2026-10-03T08:00:00.000Z', decision: true },
      { id: 'x', groupKey: 'task:t2', goalVersion: 1, blocking: false, since: '2026-10-03T09:00:00.000Z', decision: false },
      { id: 'y', groupKey: 'task:t2', goalVersion: 1, blocking: false, since: '2026-10-03T08:30:00.000Z', decision: false },
    ])
    expect(groups.map((g) => g.ids)).toEqual([['early', 'task', 'late'], ['y', 'x']])
    // A group waits since its oldest member, whoever heads it.
    expect(groups[0]?.since).toBe('2026-10-03T07:00:00.000Z')
  })

  it('heads a group with its blocking decision before an older one that blocks nothing (fix round 1)', () => {
    const groups = buildQueue([
      { id: 'stale', groupKey: 'task:t1', goalVersion: 1, blocking: false, since: '2026-10-03T07:00:00.000Z', decision: true },
      { id: 'needs-human', groupKey: 'task:t1', goalVersion: 1, blocking: true, since: '2026-10-03T09:00:00.000Z', decision: true },
      { id: 'task', groupKey: 'task:t1', goalVersion: 1, blocking: true, since: '2026-10-03T06:00:00.000Z', decision: false },
    ])
    expect(groups.map((g) => [g.ids, g.blocking])).toEqual([[['needs-human', 'task', 'stale'], true]])
  })

  it('keeps one subject apart across versions, and within a version orders blocking first, then the oldest', () => {
    const groups = buildQueue([
      { id: 'old', groupKey: 'item:x', goalVersion: 3, blocking: false, since: '2026-10-03T06:00:00.000Z', decision: true },
      { id: 'new-blocking', groupKey: 'item:y', goalVersion: 3, blocking: true, since: '2026-10-03T09:00:00.000Z', decision: true },
      { id: 'other-version', groupKey: 'item:x', goalVersion: 2, blocking: true, since: '2026-10-03T05:00:00.000Z', decision: true },
    ])
    expect(groups.map((g) => g.ids[0])).toEqual(['new-blocking', 'old', 'other-version'])
  })

  it('is empty for an empty queue', () => {
    expect(buildQueue([])).toEqual([])
  })
})
