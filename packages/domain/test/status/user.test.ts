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
  userSupervisorStatus,
  userTaskStatus,
  userWorkspaceStatus,
  type UserCardFacts,
  type UserCardState,
  type UserSupervisorState,
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
  completed: true, steered: true, constrained: true,
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

  // The gap erratum E4 declared and the first implementation left open: `done` returned
  // `autoMerge === false` and RETURNED, so a proposal waiting for approval on an auto-merge
  // project's finished-but-unintegrated task answered `false`. `done` is not terminal -- only
  // `integrated` is -- so the decision clause has to be read there too.
  it('is true on a done-but-not-integrated task with a pending decision, even where the project auto-merges (erratum E4)', () => {
    expect(needsYou({ status: 'done', integrated: false, autoMerge: true, decisionPending: true })).toBe(true)
    expect(needsYou({ status: 'done', integrated: false, autoMerge: true, decisionPending: false })).toBe(false)
    expect(needsYou({ status: 'blocked', decisionPending: true })).toBe(true)
    expect(needsYou({ status: 'merging', decisionPending: true })).toBe(true)
    expect(needsYou({ status: 'verifying', decisionPending: true })).toBe(true)
    expect(needsYou({ status: 'reviewing', decisionPending: true })).toBe(true)
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
      // M51 R7. The eleven words above are still the eleven the web rendered before M44 moved
      // them here, to the letter; these two are new states, not renamed old ones.
      steered: 'STEERED', constrained: 'CONSTRAINED',
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

  // M51 R7 / decision D6, for the WORKER projection as well as the run's (fix round 1, review
  // Important 3): the rule "the breaker speaks only over `working`" is stated once, here, and the
  // two web surfaces that show a worker's word read it rather than restating it.
  describe('the breaker’s word over a worker (M51 R7)', () => {
    it('replaces a working worker’s word with the rung the breaker is on', () => {
      expect(userSlaveStatus('working', { breakerLevel: 'steered' }).state).toBe('steered')
      expect(userSlaveStatus('working', { breakerLevel: 'steered' }).label).toBe('STEERED')
      expect(userSlaveStatus('working', { breakerLevel: 'constrained' }).state).toBe('constrained')
      expect(userSlaveStatus('working', { breakerLevel: 'constrained' }).label).toBe('CONSTRAINED')
    })

    it('says nothing at level none, with no facts, or with a facts object that carries none', () => {
      expect(userSlaveStatus('working').state).toBe('working')
      expect(userSlaveStatus('working', {}).state).toBe('working')
      expect(userSlaveStatus('working', { breakerLevel: 'none' }).state).toBe('working')
    })

    it('never speaks over a word somebody else produced', () => {
      // The same clause `userRunStatus` applies, over the seven `SlaveStatus` members: a paused or
      // stopping worker has a word somebody (or something) acted to produce, and CONSTRAINED there
      // would describe a tool budget nobody is spending.
      for (const status of slaveStatuses.filter((member) => member !== 'working')) {
        expect(userSlaveStatus(status, { breakerLevel: 'constrained' }).state).toBe(userSlaveStatus(status).state)
      }
    })

    it('needs nobody, exactly as every other card word does', () => {
      expect(userSlaveStatus('working', { breakerLevel: 'constrained' }).needsYou).toBe(false)
    })
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

/** Every UserSupervisorState, as a compile-time-complete literal: an eighth fails to compile. */
const ALL_SUPERVISOR_STATES: Record<UserSupervisorState, true> = {
  halted: true, off: true, decisions: true, answering: true, working: true, watching: true, idle: true,
}

describe('userSupervisorStatus', () => {
  const base = {
    halted: false, enabled: true, pendingDecisions: 0, pendingQuestions: 0, tasksActive: 0, tasksOpen: 0,
  }

  it('halted beats everything, and says a person is needed', () => {
    const status = userSupervisorStatus({ ...base, halted: true, enabled: false, pendingDecisions: 3 })
    expect(status.state).toBe('halted')
    expect(status.label).toBe('HALTED, NEEDS YOU')
    expect(status.needsYou).toBe(true)
  })

  it('a switched-off Supervisor says so, even with work in flight', () => {
    const status = userSupervisorStatus({ ...base, enabled: false, tasksActive: 4 })
    expect(status.state).toBe('off')
    expect(status.label).toBe('OFF')
    expect(status.needsYou).toBe(false)
  })

  it('pending decisions are counted into the label and need a person', () => {
    expect(userSupervisorStatus({ ...base, pendingDecisions: 1 }).label).toBe('1 DECISION WAITING')
    const many = userSupervisorStatus({ ...base, pendingDecisions: 3, pendingQuestions: 2, tasksActive: 5 })
    expect(many.state).toBe('decisions')
    expect(many.label).toBe('3 DECISIONS WAITING')
    expect(many.needsYou).toBe(true)
  })

  it('an unanswered question outranks work in flight', () => {
    const status = userSupervisorStatus({ ...base, pendingQuestions: 1, tasksActive: 2 })
    expect(status.state).toBe('answering')
    expect(status.label).toBe('ANSWERING')
    expect(status.needsYou).toBe(false)
  })

  it('work in flight reads WORKING', () => {
    expect(userSupervisorStatus({ ...base, tasksActive: 1, tasksOpen: 6 }).state).toBe('working')
  })

  it('open work with nothing active is WATCHING, and an empty board is IDLE', () => {
    expect(userSupervisorStatus({ ...base, tasksOpen: 2 }).state).toBe('watching')
    expect(userSupervisorStatus(base).state).toBe('idle')
  })

  it('every state this projection can answer is one the seven-word list names', () => {
    const states = Object.keys(ALL_SUPERVISOR_STATES)
    expect(states).toHaveLength(7)
    // Each of the seven reached through the facts that produce it -- an eighth state would have no
    // row here and no word, and the `Record` above would already have failed to compile.
    const reached = [
      userSupervisorStatus({ ...base, halted: true }),
      userSupervisorStatus({ ...base, enabled: false }),
      userSupervisorStatus({ ...base, pendingDecisions: 2 }),
      userSupervisorStatus({ ...base, pendingQuestions: 1 }),
      userSupervisorStatus({ ...base, tasksActive: 1 }),
      userSupervisorStatus({ ...base, tasksOpen: 1 }),
      userSupervisorStatus(base),
    ]
    expect(reached.map((status) => status.state).sort()).toEqual(states.sort())
    for (const status of reached) expect(status.label.length).toBeGreaterThan(0)
  })
})

describe('userRunStatus with breaker facts (M51 R7)', () => {
  it('reads exactly as it always did when called with one argument', () => {
    // The ~20 existing call sites, unchanged: `apps/web/src/lib/tones.ts`'s `cardStateForRun` is
    // the adapter they all go through and it passes no facts.
    expect(userRunStatus('working')).toEqual({ state: 'working', label: 'WORKING', needsYou: false })
    expect(userRunStatus(null).state).toBe('idle')
  })

  it('says STEERED and CONSTRAINED for a working run the breaker has spoken to', () => {
    expect(userRunStatus('working', { breakerLevel: 'steered' })).toEqual({
      state: 'steered',
      label: 'STEERED',
      needsYou: false,
    })
    expect(userRunStatus('working', { breakerLevel: 'constrained' }).label).toBe('CONSTRAINED')
  })

  it('says nothing new at level `none`, or with an empty facts object', () => {
    expect(userRunStatus('working', { breakerLevel: 'none' }).state).toBe('working')
    expect(userRunStatus('working', {}).state).toBe('working')
  })

  it('never lets a breaker level speak over a status a person acted on', () => {
    // A paused run reads PAUSED even at level `constrained`: somebody (or the breaker itself) has
    // stopped it, and "constrained" would describe a budget nobody is spending.
    const facts: UserCardFacts = { breakerLevel: 'constrained' }
    expect(userRunStatus('paused', facts).state).toBe('paused')
    expect(userRunStatus('pause_requested', facts).state).toBe('pause_requested')
    expect(userRunStatus('failed', facts).state).toBe('blocked')
    expect(userRunStatus('succeeded', facts).state).toBe('completed')
    expect(userRunStatus(null, facts).state).toBe('idle')
  })

  it('gives both new states a word', () => {
    expect(USER_CARD_LABEL.steered).toBe('STEERED')
    expect(USER_CARD_LABEL.constrained).toBe('CONSTRAINED')
  })
})
