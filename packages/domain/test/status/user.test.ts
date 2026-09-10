import { describe, expect, it } from 'vitest'
import type { RunStatus, SlaveStatus, TaskStatus } from '../../src/index.js'
import {
  USER_CARD_LABEL,
  USER_TASK_LABEL,
  USER_TASK_STATE_FOR_STATUS,
  USER_WORKSPACE_LABEL,
  needsYou,
  userRunStatus,
  userSlaveStatus,
  userTaskStatus,
  userWorkspaceStatus,
  type UserCardState,
  type UserTaskState,
  type UserWorkspaceState,
} from '../../src/status/user.js'

/** Every TaskStatus, as a compile-time-complete literal: a fourteenth member fails to compile. */
const ALL_TASK_STATUSES: Record<TaskStatus, true> = {
  backlog: true, ready: true, blocked: true, assigned: true, running: true, verifying: true,
  reviewing: true, merging: true, rework: true, waiting: true, done: true, failed: true,
  cancelled: true,
}
const ALL_RUN_STATUSES: Record<RunStatus, true> = {
  starting: true, working: true, pause_requested: true, paused: true, resuming: true,
  stopping: true, stopped: true, succeeded: true, failed: true,
}
const ALL_SLAVE_STATUSES: Record<SlaveStatus, true> = {
  idle: true, starting: true, working: true, pausing: true, paused: true, resuming: true,
  stopping: true,
}
const ALL_TASK_STATES: Record<UserTaskState, true> = {
  queued: true, working: true, verifying: true, review: true, merging: true, waiting: true,
  blocked: true, done: true, integrated: true, failed: true, cancelled: true,
}
const ALL_CARD_STATES: Record<UserCardState, true> = {
  working: true, planning: true, waiting: true, review: true, paused: true,
  pause_requested: true, resuming: true, blocked: true, cancelled: true, idle: true,
  completed: true,
}
const ALL_WORKSPACE_STATES: Record<UserWorkspaceState, true> = {
  archived: true, halted: true, needs_you: true, working: true, idle: true,
}

const taskStatuses = Object.keys(ALL_TASK_STATUSES) as TaskStatus[]
const runStatuses = Object.keys(ALL_RUN_STATUSES) as RunStatus[]
const slaveStatuses = Object.keys(ALL_SLAVE_STATUSES) as SlaveStatus[]

describe('userTaskStatus', () => {
  it('gives every TaskStatus a state and a non-empty label', () => {
    for (const status of taskStatuses) {
      const projected = userTaskStatus({ status })
      expect(ALL_TASK_STATES[projected.state]).toBe(true)
      expect(projected.label.length).toBeGreaterThan(0)
      expect(projected.label).toBe(USER_TASK_LABEL[projected.state])
    }
  })

  it('reaches every UserTaskState from some input -- no state is unreachable', () => {
    const reached = new Set<UserTaskState>(taskStatuses.map((status) => userTaskStatus({ status }).state))
    reached.add(userTaskStatus({ status: 'done', integrated: true }).state)
    expect([...reached].sort()).toEqual(Object.keys(ALL_TASK_STATES).sort())
  })

  it('spells the eleven labels the spec names', () => {
    expect(USER_TASK_LABEL).toEqual({
      queued: 'QUEUED', working: 'WORKING', verifying: 'VERIFYING', review: 'IN REVIEW',
      merging: 'MERGING', waiting: 'WAITING', blocked: 'BLOCKED', done: 'DONE',
      integrated: 'INTEGRATED', failed: 'FAILED', cancelled: 'CANCELLED',
    })
  })

  it('groups the pre-run statuses under QUEUED and keeps the in-flight ones apart', () => {
    expect(USER_TASK_STATE_FOR_STATUS.backlog).toBe('queued')
    expect(USER_TASK_STATE_FOR_STATUS.ready).toBe('queued')
    expect(USER_TASK_STATE_FOR_STATUS.rework).toBe('queued')
    expect(USER_TASK_STATE_FOR_STATUS.assigned).toBe('queued')
    expect(USER_TASK_STATE_FOR_STATUS.running).toBe('working')
    expect(USER_TASK_STATE_FOR_STATUS.verifying).toBe('verifying')
    expect(USER_TASK_STATE_FOR_STATUS.reviewing).toBe('review')
    expect(USER_TASK_STATE_FOR_STATUS.merging).toBe('merging')
  })

  it('says INTEGRATED only once the work is actually in the base branch', () => {
    expect(userTaskStatus({ status: 'done' }).state).toBe('done')
    expect(userTaskStatus({ status: 'done', integrated: true }).state).toBe('integrated')
    expect(userTaskStatus({ status: 'done', integrated: true }).label).toBe('INTEGRATED')
  })
})

describe('needsYou', () => {
  it('is true for a blocked task', () => {
    expect(needsYou({ status: 'blocked' })).toBe(true)
    expect(userTaskStatus({ status: 'blocked' }).needsYou).toBe(true)
  })

  it('is true for a waiting task whose question nobody holds, and false when a slave does', () => {
    expect(needsYou({ status: 'waiting', questionHolder: 'nobody' })).toBe(true)
    expect(needsYou({ status: 'waiting', questionHolder: 'slave' })).toBe(false)
    expect(needsYou({ status: 'waiting' })).toBe(false)
  })

  it('is true for done work nobody has integrated on a hand-merge project, and false on an auto-merge one', () => {
    expect(needsYou({ status: 'done', autoMerge: false })).toBe(true)
    expect(needsYou({ status: 'done', autoMerge: true })).toBe(false)
    expect(needsYou({ status: 'done', autoMerge: false, integrated: true })).toBe(false)
  })

  it('is true wherever a Supervisor decision is waiting on a human, not only while waiting (erratum E4)', () => {
    expect(needsYou({ status: 'running', decisionPending: true })).toBe(true)
    expect(needsYou({ status: 'ready', decisionPending: true })).toBe(true)
    expect(needsYou({ status: 'waiting', decisionPending: true })).toBe(true)
  })

  it('is false on a terminal task, decision or not -- nothing a person does moves it (erratum E4)', () => {
    expect(needsYou({ status: 'cancelled', decisionPending: true })).toBe(false)
    expect(needsYou({ status: 'failed', decisionPending: true })).toBe(false)
    expect(needsYou({ status: 'failed' })).toBe(false)
    expect(needsYou({ status: 'done', autoMerge: false, integrated: true, decisionPending: true })).toBe(false)
  })

  it('defaults to the safe answer with no facts beyond the status', () => {
    for (const status of taskStatuses) {
      const bare = userTaskStatus({ status }).needsYou
      expect(bare).toBe(status === 'blocked')
    }
  })
})

describe('userRunStatus and userSlaveStatus', () => {
  it('gives every RunStatus, and no run at all, a card state and its label', () => {
    for (const status of [...runStatuses, null]) {
      const projected = userRunStatus(status)
      expect(ALL_CARD_STATES[projected.state]).toBe(true)
      expect(projected.label).toBe(USER_CARD_LABEL[projected.state])
      expect(projected.needsYou).toBe(false)
    }
    expect(userRunStatus(null).state).toBe('idle')
  })

  it('gives every SlaveStatus a card state and its label', () => {
    for (const status of slaveStatuses) {
      const projected = userSlaveStatus(status)
      expect(ALL_CARD_STATES[projected.state]).toBe(true)
      expect(projected.label).toBe(USER_CARD_LABEL[projected.state])
    }
  })

  it('keeps the labels the web already renders, to the letter (erratum E2)', () => {
    expect(USER_CARD_LABEL).toEqual({
      working: 'WORKING', planning: 'PLANNING', waiting: 'WAITING', review: 'REVIEW',
      paused: 'PAUSED', pause_requested: 'PAUSING', resuming: 'RESUMING', blocked: 'BLOCKED',
      cancelled: 'CANCELLED', idle: 'IDLE', completed: 'DONE',
    })
  })

  it('reproduces the three derivations lib/tones.ts already made', () => {
    expect(userRunStatus('starting').state).toBe('planning')
    expect(userRunStatus('pause_requested').state).toBe('pause_requested')
    expect(userRunStatus('stopping').state).toBe('waiting')
    expect(userRunStatus('stopped').state).toBe('idle')
    expect(userRunStatus('succeeded').state).toBe('completed')
    expect(userRunStatus('failed').state).toBe('blocked')
    expect(userSlaveStatus('pausing').state).toBe('pause_requested')
    expect(userSlaveStatus('stopping').state).toBe('waiting')
    expect(userSlaveStatus('idle').state).toBe('idle')
  })
})

describe('userWorkspaceStatus', () => {
  const base = { archived: false, halted: false, needsYouCount: 0, tasksActive: 0 }

  it('gives every state its own word', () => {
    expect(USER_WORKSPACE_LABEL).toEqual({
      archived: 'ARCHIVED', halted: 'HALTED', needs_you: 'WAITING FOR YOU',
      working: 'WORKING', idle: 'IDLE',
    })
    for (const state of Object.keys(ALL_WORKSPACE_STATES) as UserWorkspaceState[]) {
      expect(USER_WORKSPACE_LABEL[state].length).toBeGreaterThan(0)
    }
  })

  it('reads archived first, then halted, then the person, then the work', () => {
    expect(userWorkspaceStatus({ ...base, archived: true, halted: true, needsYouCount: 3, tasksActive: 2 }).state).toBe('archived')
    expect(userWorkspaceStatus({ ...base, halted: true, needsYouCount: 3, tasksActive: 2 }).state).toBe('halted')
    expect(userWorkspaceStatus({ ...base, needsYouCount: 1, tasksActive: 2 }).state).toBe('needs_you')
    expect(userWorkspaceStatus({ ...base, tasksActive: 2 }).state).toBe('working')
    expect(userWorkspaceStatus(base).state).toBe('idle')
  })

  it('carries needsYou on the project row too', () => {
    expect(userWorkspaceStatus({ ...base, needsYouCount: 1 }).needsYou).toBe(true)
    expect(userWorkspaceStatus({ ...base, halted: true }).needsYou).toBe(true)
    expect(userWorkspaceStatus({ ...base, tasksActive: 4 }).needsYou).toBe(false)
    expect(userWorkspaceStatus({ ...base, archived: true, needsYouCount: 9 }).needsYou).toBe(false)
  })
})
