import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  MEMORY_CANDIDATE_STALE_MS,
  PERMISSION_DENIAL_WINDOW_MS,
  PERMISSION_TRIP_COUNT,
  RUN_PROMPT_MAX_CHARS,
  STALE_CANDIDATES_MIN,
  SUPERVISOR_PER_CALL_CAP_USD,
  THREAD_BODY_MAX_CHARS,
  THREAD_MESSAGES_MAX,
  observe,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { beforeEach, describe, expect, it } from 'vitest'
import { recordMemory } from '../../src/memory.js'
import { adoptRunbook, syncRunbooks } from '../../src/runbook.js'
import { workspaceSpend } from '../../src/spend.js'
import { workspaceStats } from '../../src/stats.js'
import { setStaffingPreference } from '../../src/staffing.js'
import { RUNBOOKS_IN_WORLD_MAX, loadSupervisorWorld } from '../../src/supervisorWorld.js'
import {
  BACKEND_SERVICES_LABEL,
  seedEvidenceFixture,
  seedEvidenceRows,
  type EvidenceFixture,
} from './fixtures/evidence.js'

const NOW = new Date('2026-09-09T12:00:00.000Z')
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)

const reset = async (): Promise<void> => {
  // M47 added the catalog and roster tables: the capability cases below write a `SlaveTemplate`
  // and a `CompanySlave`, both name-unique, so a second run of this file would collide on rows the
  // first left behind. `Capability` stays out -- it is the seeded taxonomy other files read.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "User", "CollaborationHint", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
}

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
}

async function seed(
  data: {
    readonly goal?: string
    readonly goalVersion?: number
    readonly haltedReason?: string
    readonly budgetUsd?: number | null
  } = {},
): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: `Checkout ${String(Math.random()).slice(2)}`,
      repoPath: '/tmp/checkout',
      verifyCommands: ['npm test'],
      setupCommands: [],
      ...(data.goal === undefined ? {} : { goal: data.goal }),
      ...(data.goalVersion === undefined ? {} : { goalVersion: data.goalVersion }),
      ...(data.haltedReason === undefined ? {} : { haltedReason: data.haltedReason, haltedAt: NOW }),
      ...(data.budgetUsd === undefined ? {} : { budgetUsd: data.budgetUsd }),
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

async function makeTask(
  fixture: Fixture,
  data: {
    readonly title: string
    readonly status: 'ready' | 'running' | 'blocked' | 'done' | 'failed' | 'reviewing'
    readonly requiredRole?: string | null
    readonly integratedAt?: Date | null
    readonly createdAt?: Date
    readonly goalVersion?: number | null
    readonly requiredCapabilities?: readonly string[]
    readonly stage?: string
    readonly handoff?: Prisma.InputJsonValue
  },
): Promise<string> {
  const task = await prisma.task.create({
    data: {
      workspaceId: fixture.workspaceId,
      title: data.title,
      description: 'a task',
      status: data.status,
      requiredRole: data.requiredRole === undefined ? 'backend' : data.requiredRole,
      maxAttempts: 3,
      attempt: 1,
      ...(data.integratedAt === undefined ? {} : { integratedAt: data.integratedAt }),
      ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
      ...(data.goalVersion === undefined ? {} : { goalVersion: data.goalVersion }),
      ...(data.requiredCapabilities === undefined ? {} : { requiredCapabilities: [...data.requiredCapabilities] }),
      ...(data.stage === undefined ? {} : { stage: data.stage }),
      ...(data.handoff === undefined ? {} : { handoff: data.handoff }),
    },
  })
  return task.id
}

/** One thing a worker reported and nobody has verified -- the shape M49's stale count is about. */
const candidateDraft = (workspaceId: string, title: string): Record<string, unknown> => ({
  type: 'observation',
  scope: 'workspace',
  companyId: null,
  workspaceId,
  slaveId: null,
  title,
  body: 'the worker says it did the thing',
  status: 'candidate',
  confidence: 'interpretation',
  capabilities: [],
  verifiedBy: null,
  supersedesTaskCandidates: false,
  supersedesGoalDecisions: false,
  supersedesTaskFacts: false,
  provenance: {
    sourceKind: 'run_output',
    sourceRef: '1',
    createdBy: 'slave',
    createdByUserId: null,
    taskId: null,
    runId: null,
    goalVersion: null,
  },
})

describe('loadSupervisorWorld', () => {
  beforeEach(reset)

  /**
   * M40 §4. Both stamps come off real columns, not a placeholder: `world.goalVersion` is the
   * workspace's cache of the newest `GoalVersion`, and each task carries the version the plan that
   * produced it derived from -- null for a hand-made one. The domain's `summarise` compares the
   * two to count STALE tasks, so a loader that answered 0 for either would make every task look
   * current forever.
   */
  it('carries the workspace goal version and each task\'s own, null for a hand-made task', async (): Promise<void> => {
    const fixture = await seed({ goal: 'Ship the checkout redesign', goalVersion: 2 })
    const current = await makeTask(fixture, { title: 'planned by v2', status: 'ready', goalVersion: 2 })
    const stale = await makeTask(fixture, { title: 'planned by v1', status: 'ready', goalVersion: 1 })
    const handMade = await makeTask(fixture, { title: 'typed in by a human', status: 'ready' })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)

    expect(world.goalVersion).toBe(2)
    const versionOf = (id: string): number | null | undefined => world.tasks.find((task) => task.id === id)?.goalVersion
    expect(versionOf(current)).toBe(2)
    expect(versionOf(stale)).toBe(1)
    expect(versionOf(handMade)).toBeNull()
  })

  it('reports goal version 0 for a project whose goal has never been set', async (): Promise<void> => {
    const fixture = await seed()
    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.goalVersion).toBe(0)
  })

  it('maps tasks with their dependents, integration-gated dependenciesDone, statusSince and latest guardrail', async (): Promise<void> => {
    const fixture = await seed()
    const doneUnintegrated = await makeTask(fixture, { title: 'the dependency', status: 'done', integratedAt: null })
    const blocked = await makeTask(fixture, { title: 'the dependent', status: 'blocked', createdAt: ago(3 * 3_600_000) })
    await prisma.taskDependency.create({ data: { taskId: blocked, dependsOnTaskId: doneUnintegrated } })

    // The newest `task.*` event is what `statusSince` reads; the older one and the run event in
    // between must not win.
    await prisma.executionEvent.create({
      data: { workspaceId: fixture.workspaceId, taskId: blocked, type: 'task_created', actor: 'system', payload: {}, ts: ago(3 * 3_600_000) },
    })
    await prisma.executionEvent.create({
      data: { workspaceId: fixture.workspaceId, taskId: blocked, type: 'task_rework', actor: 'system', payload: {}, ts: ago(90 * 60_000) },
    })
    await prisma.executionEvent.create({
      data: { workspaceId: fixture.workspaceId, taskId: blocked, type: 'run_started', actor: 'system', payload: {}, ts: ago(30 * 60_000) },
    })
    await prisma.executionEvent.create({
      data: {
        workspaceId: fixture.workspaceId,
        taskId: blocked,
        type: 'guardrail_tripped',
        actor: 'system',
        payload: { guardrail: 'verify_failed', detail: 'nope' },
        ts: ago(120 * 60_000),
      },
    })
    await prisma.executionEvent.create({
      data: {
        workspaceId: fixture.workspaceId,
        taskId: blocked,
        type: 'guardrail_tripped',
        actor: 'system',
        payload: { guardrail: 'review_retry_cap_exhausted', detail: 'out of retries' },
        ts: ago(60 * 60_000),
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)

    expect(world.now).toBe(NOW.getTime())
    const dependency = world.tasks.find((task) => task.id === doneUnintegrated)
    const dependent = world.tasks.find((task) => task.id === blocked)
    expect(dependency?.dependents).toBe(1)
    expect(dependency?.dependenciesDone).toBe(true)
    expect(dependency?.integratedAt).toBeNull()
    // `done` but never integrated: the dependent is NOT startable, exactly as `world.ts` gates it.
    expect(dependent?.dependenciesDone).toBe(false)
    expect(dependent?.dependents).toBe(0)
    expect(dependent?.statusSince).toBe(ago(90 * 60_000).getTime())
    expect(dependent?.latestGuardrail).toBe('review_retry_cap_exhausted')
    expect(dependency?.latestGuardrail).toBeNull()
  })

  it('falls back to createdAt for a task with no task.* event of its own', async (): Promise<void> => {
    const fixture = await seed()
    const createdAt = ago(5 * 3_600_000)
    const id = await makeTask(fixture, { title: 'untouched', status: 'ready', createdAt })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.tasks.find((task) => task.id === id)?.statusSince).toBe(createdAt.getTime())
  })

  it('drops a task with no required role and keeps one whose role is the empty string', async (): Promise<void> => {
    const fixture = await seed()
    const roleless = await makeTask(fixture, { title: 'roleless', status: 'ready', requiredRole: null })
    const anyRole = await makeTask(fixture, { title: 'any role will do', status: 'ready', requiredRole: '' })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.tasks.map((task) => task.id)).not.toContain(roleless)
    expect(world.tasks.find((task) => task.id === anyRole)?.requiredRole).toBe('')
  })

  it('reports a slave as busy only while it holds a non-terminal run', async (): Promise<void> => {
    const fixture = await seed()
    const busy = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Alex', role: 'Senior Engineer', runtimeRoles: ['backend'] },
    })
    const idle = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Blair', role: 'QA Reviewer', runtimeRoles: [] },
    })
    await prisma.slaveRun.create({ data: { slaveId: busy.id, status: 'working', kind: 'implementation' } })
    await prisma.slaveRun.create({ data: { slaveId: idle.id, status: 'succeeded', kind: 'implementation' } })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.slaves.find((slave) => slave.id === busy.id)).toMatchObject({
      busy: true,
      name: 'Alex',
      role: 'Senior Engineer',
      runtimeRoles: ['backend'],
    })
    expect(world.slaves.find((slave) => slave.id === idle.id)?.busy).toBe(false)
  })

  it('carries only questions somebody is still waiting on', async (): Promise<void> => {
    const fixture = await seed()
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation' },
    })
    const finishedRun = await prisma.slaveRun.create({ data: { slaveId: asker.id, status: 'succeeded', kind: 'implementation' } })
    const pending = await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        senderRunId: waitingRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-1',
        kind: 'question',
        body: 'which branch?',
        expectsReply: true,
        createdAt: ago(45 * 60_000),
      },
    })
    // Nobody is waiting on this one any more -- its asker's run concluded.
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        senderRunId: finishedRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-2',
        kind: 'question',
        body: 'and this one?',
        expectsReply: true,
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions).toHaveLength(1)
    expect(world.questions[0]).toMatchObject({
      messageId: pending.id,
      askerSlaveId: asker.id,
      recipientRole: 'reviewer',
      recipientSlaveId: null,
      createdAt: ago(45 * 60_000).getTime(),
    })
  })

  it('carries the whole question: its body, its task, its thread, the asker run context and who may answer', async (): Promise<void> => {
    const fixture = await seed({ goal: 'ship checkout' })
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    const reviewer = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Robin', role: 'QA', runtimeRoles: ['reviewer', 'backend'] },
    })
    const taskId = await makeTask(fixture, { title: 'Wire the database', status: 'running' })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation', taskId },
    })
    await prisma.runContext.create({
      data: { runId: waitingRun.id, prompt: 'You are Maya. The database listens on 5433.', sections: [] },
    })
    const question = await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        taskId,
        senderRunId: waitingRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-1',
        kind: 'question',
        body: 'Which port does the database listen on?',
        actor: 'slave',
        expectsReply: true,
        createdAt: ago(45 * 60_000),
      },
    })
    // Two more messages in the SAME thread: a worker's note (a `note` to the Supervisor) and a
    // system-authored one, whose sender is nobody.
    const note = await prisma.slaveMessage.create({
      data: {
        slaveId: reviewer.id,
        workspaceId: fixture.workspaceId,
        recipientSlaveId: asker.id,
        threadId: 'thread-1',
        kind: 'information',
        body: 'I looked at the compose file earlier.',
        actor: 'slave',
        createdAt: ago(40 * 60_000),
      },
    })
    const operatorNote = await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        recipientSlaveId: asker.id,
        threadId: 'thread-1',
        kind: 'information',
        body: 'The operator is looking into it.',
        actor: 'human',
        createdAt: ago(35 * 60_000),
      },
    })
    // A different thread entirely: never in this question's thread.
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        threadId: 'thread-2',
        kind: 'information',
        body: 'unrelated chatter',
        actor: 'slave',
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)

    expect(world.questions).toHaveLength(1)
    const loaded = world.questions[0]
    expect(loaded).toMatchObject({
      messageId: question.id,
      askerSlaveId: asker.id,
      recipientRole: 'reviewer',
      recipientSlaveId: null,
      createdAt: ago(45 * 60_000).getTime(),
      body: 'Which port does the database listen on?',
      taskId,
      taskTitle: 'Wire the database',
      taskDescription: 'a task',
      senderRunId: waitingRun.id,
      threadId: 'thread-1',
      askerRunPrompt: 'You are Maya. The database listens on 5433.',
    })
    // The thread is oldest first and INCLUDES the question itself -- `verifySources` needs it there
    // precisely so it can refuse a citation of it.
    expect(loaded?.thread).toEqual([
      { messageId: question.id, kind: 'question', senderSlaveId: asker.id, body: 'Which port does the database listen on?', createdAt: ago(45 * 60_000).getTime() },
      { messageId: note.id, kind: 'note', senderSlaveId: reviewer.id, body: 'I looked at the compose file earlier.', createdAt: ago(40 * 60_000).getTime() },
      // Nobody's run wrote this one, so it has no sender slave.
      { messageId: operatorNote.id, kind: 'note', senderSlaveId: null, body: 'The operator is looking into it.', createdAt: ago(35 * 60_000).getTime() },
    ])
    // Role-addressed: whoever holds "reviewer", and nobody else.
    expect(loaded?.holders).toEqual([reviewer.id])
  })

  it('caps a thread body and a run prompt rather than putting a pasted file into a prompt', async (): Promise<void> => {
    const fixture = await seed()
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation' },
    })
    await prisma.runContext.create({
      data: { runId: waitingRun.id, prompt: 'p'.repeat(RUN_PROMPT_MAX_CHARS + 500), sections: [] },
    })
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        senderRunId: waitingRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-1',
        kind: 'question',
        body: 'q'.repeat(THREAD_BODY_MAX_CHARS + 500),
        actor: 'slave',
        expectsReply: true,
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    const loaded = world.questions[0]
    expect(loaded?.askerRunPrompt).toHaveLength(RUN_PROMPT_MAX_CHARS)
    expect(loaded?.thread[0]?.body).toHaveLength(THREAD_BODY_MAX_CHARS)
    // The question's OWN body is NOT capped (fix round 1, Important 1): the critical lexicon reads
    // this field, and a truncated body would let "which api key?" written past the cap slip the E2
    // short-circuit and buy a second model call. The cap that bounds a call lives in
    // `buildAnswerPrompt`; the thread copy above carries the one that bounds quoting.
    expect(loaded?.body).toHaveLength(THREAD_BODY_MAX_CHARS + 500)
  })

  it('gives a question with no task, no run context and no holder the empty values rather than guesses', async (): Promise<void> => {
    const fixture = await seed()
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'planning' },
    })
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        senderRunId: waitingRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-1',
        kind: 'question',
        body: 'anyone?',
        actor: 'slave',
        expectsReply: true,
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions[0]).toMatchObject({
      taskId: null,
      taskTitle: null,
      taskDescription: null,
      askerRunPrompt: null,
      holders: [],
    })
  })

  it('holds a slave-addressed question for the addressee plus every peer who could take the asking task', async (): Promise<void> => {
    // Erratum E5, the case the two halves of `holders` differ on: a question addressed to ONE
    // worker may also be answered by anybody who could have been dispatched the asking task.
    const fixture = await seed()
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    const addressed = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Robin', role: 'QA', runtimeRoles: ['reviewer'] },
    })
    const peer = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Sam', role: 'Backend', runtimeRoles: ['backend'] },
    })
    // Holds neither the addressee's identity nor the task's role.
    await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Kim', role: 'Design', runtimeRoles: ['design'] },
    })
    const taskId = await makeTask(fixture, { title: 'Wire the database', status: 'running', requiredRole: 'backend' })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation', taskId },
    })
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        taskId,
        senderRunId: waitingRun.id,
        recipientSlaveId: addressed.id,
        threadId: 'thread-1',
        kind: 'question',
        body: 'which port?',
        actor: 'slave',
        expectsReply: true,
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions[0]?.holders.toSorted()).toEqual([addressed.id, peer.id].toSorted())
  })

  /**
   * Erratum E8, the final review's Important 4. The asker holds the asking task's role by
   * construction -- that is how it came to be doing the task it asked about -- so it fell straight
   * into `holders` on this branch, and the panel told an operator "2 workers could answer it" about
   * a question exactly one worker could answer. Nobody answers their own question.
   */
  it('never counts the ASKER as a holder, even though it holds the asking task\'s own role', async (): Promise<void> => {
    const fixture = await seed()
    // The asker holds `backend`, the very role its task requires.
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'Backend', runtimeRoles: ['backend'] },
    })
    const addressed = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Robin', role: 'QA', runtimeRoles: ['reviewer'] },
    })
    const taskId = await makeTask(fixture, { title: 'Wire the database', status: 'running', requiredRole: 'backend' })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation', taskId },
    })
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        taskId,
        senderRunId: waitingRun.id,
        recipientSlaveId: addressed.id,
        threadId: 'thread-1',
        kind: 'question',
        body: 'which port?',
        actor: 'slave',
        expectsReply: true,
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions[0]?.holders).toEqual([addressed.id])
  })

  it('never counts the asker as a holder of a ROLE-addressed question it happens to hold', async (): Promise<void> => {
    const fixture = await seed()
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'Reviewer', runtimeRoles: ['reviewer'] },
    })
    const reviewer = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Robin', role: 'QA', runtimeRoles: ['reviewer'] },
    })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation' },
    })
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        senderRunId: waitingRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-1',
        kind: 'question',
        body: 'which port?',
        actor: 'slave',
        expectsReply: true,
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions[0]?.holders).toEqual([reviewer.id])
  })

  /**
   * Erratum E9. Nothing bounded a thread before this: a conversation two workers had been having
   * for a week went into the world entire and from there into an answer call, so the size of the
   * prompt was whatever they had typed at each other.
   */
  it('carries at most THREAD_MESSAGES_MAX thread messages, newest last, question always among them', async (): Promise<void> => {
    const fixture = await seed()
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    const peer = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Robin', role: 'QA', runtimeRoles: ['reviewer'] },
    })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation' },
    })
    // The QUESTION first, so it is the OLDEST of the 45 and falls outside a plain newest-40 window.
    const question = await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        senderRunId: waitingRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-1',
        kind: 'question',
        body: 'which port?',
        actor: 'slave',
        expectsReply: true,
      },
    })
    const notes: string[] = []
    for (let index = 0; index < 44; index += 1) {
      const note = await prisma.slaveMessage.create({
        data: {
          slaveId: peer.id,
          workspaceId: fixture.workspaceId,
          threadId: 'thread-1',
          kind: 'information',
          body: `note-${String(index)}`,
          actor: 'slave',
        },
      })
      notes.push(note.id)
    }

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    const thread = world.questions[0]?.thread ?? []
    expect(thread).toHaveLength(THREAD_MESSAGES_MAX)
    // The question is kept however old it is: `verifySources` looks it up IN the thread to refuse a
    // citation of it, so a window that dropped it would re-open the hole erratum E4 closed.
    expect(thread[0]?.messageId).toBe(question.id)
    // Newest last, and the messages that went are the OLDEST notes -- the five just after the
    // question, since the question itself takes the place of the sixth.
    expect(thread[1]?.messageId).toBe(notes[5])
    expect(thread.at(-1)?.messageId).toBe(notes.at(-1))
    const bodies = thread.map((message) => message.body)
    expect(bodies).not.toContain('note-0')
    // notes[4] is the message the question displaced -- the window is still exactly the cap wide.
    expect(bodies).not.toContain('note-4')
    expect(bodies).toContain('note-5')
  })

  it('adds nobody for a slave-addressed question whose task takes any role at all', async (): Promise<void> => {
    // Erratum E5's parenthesis: a null or EMPTY `requiredRole` is not a role to match on, so the
    // addressee is the only holder -- the empty string must not read as "everybody".
    const fixture = await seed()
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    const addressed = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Robin', role: 'QA', runtimeRoles: ['reviewer'] },
    })
    await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Sam', role: 'Backend', runtimeRoles: ['backend'] },
    })
    const taskId = await makeTask(fixture, { title: 'Anything goes', status: 'running', requiredRole: '' })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation', taskId },
    })
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        taskId,
        senderRunId: waitingRun.id,
        recipientSlaveId: addressed.id,
        threadId: 'thread-1',
        kind: 'question',
        body: 'which port?',
        actor: 'slave',
        expectsReply: true,
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions[0]?.holders).toEqual([addressed.id])
  })

  it('never lists a slave from another workspace as a holder', async (): Promise<void> => {
    const fixture = await seed()
    const other = await seed()
    await prisma.slave.create({
      data: { teamId: other.teamId, name: 'Stranger', role: 'QA', runtimeRoles: ['reviewer'] },
    })
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    const waitingRun = await prisma.slaveRun.create({
      data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation' },
    })
    await prisma.slaveMessage.create({
      data: {
        slaveId: asker.id,
        workspaceId: fixture.workspaceId,
        senderRunId: waitingRun.id,
        recipientRole: 'reviewer',
        threadId: 'thread-1',
        kind: 'question',
        body: 'which port?',
        actor: 'slave',
        expectsReply: true,
      },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions[0]?.holders).toEqual([])
  })

  it('reuses a stats snapshot the caller already read instead of reading its own', async (): Promise<void> => {
    // One reading of the limits and the spend per tick (M39 §4). The sentinel says something the
    // database does NOT: an unhalted, unbudgeted workspace comes back halted and exhausted, which
    // is only possible if the loader used what it was handed.
    const fixture = await seed()
    const real = await workspaceStats(fixture.workspaceId)
    const sentinel = {
      ...real,
      haltedReason: 'the snapshot the tick already had',
      limits: { ...real.limits, budgetUsd: 1 },
      stats: { ...real.stats, spentUsd: 99 },
    }

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW, { stats: sentinel })

    expect(world.halted).toEqual({ reason: 'the snapshot the tick already had' })
    expect(world.budgetExhausted).toBe(true)

    // And without it, the database's own reading stands.
    const fresh = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(fresh.world.halted).toBeNull()
    expect(fresh.world.budgetExhausted).toBe(false)
  })

  it('carries the last 24 hours of decisions with their tier, and nothing older', async (): Promise<void> => {
    const fixture = await seed()
    const row = {
      workspaceId: fixture.workspaceId,
      situationKind: 'review_cap_blocked' as const,
      subjectId: 'task-1',
      situation: {},
      candidates: [],
      chosenIndex: 0,
      action: { kind: 'no_action' },
      rationale: 'nothing to do',
      decidedBy: 'rules' as const,
    }
    await prisma.supervisorDecision.create({
      data: { ...row, tier: 'escalated', status: 'pending', createdAt: ago(60 * 60_000) },
    })
    await prisma.supervisorDecision.create({
      data: { ...row, subjectId: 'task-old', tier: 'applied', status: 'applied', createdAt: ago(25 * 3_600_000) },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.decisions).toHaveLength(1)
    expect(world.decisions[0]).toMatchObject({
      situationKind: 'review_cap_blocked',
      subjectId: 'task-1',
      actionKind: 'no_action',
      status: 'pending',
      tier: 'escalated',
      createdAt: ago(60 * 60_000).getTime(),
      resolvedAt: null,
    })
  })

  it('names the action each decision took, and calls one nobody can read any more no_action', async (): Promise<void> => {
    const fixture = await seed()
    const row = {
      workspaceId: fixture.workspaceId,
      situationKind: 'waiting_stale' as const,
      situation: {},
      candidates: [],
      chosenIndex: 0,
      rationale: 'nothing to do',
      decidedBy: 'rules' as const,
      tier: 'proposed' as const,
      status: 'pending' as const,
    }
    await prisma.supervisorDecision.create({
      data: { ...row, subjectId: 'm1', action: { kind: 'answer_question', messageId: 'm1' } },
    })
    // An M38 row whose action left the catalogue in M39. A tick must not throw over it.
    await prisma.supervisorDecision.create({
      data: { ...row, subjectId: 'm2', action: { kind: 'nudge_answer', messageId: 'm2' } },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    const bySubject = new Map(world.decisions.map((decision) => [decision.subjectId, decision.actionKind]))
    expect(bySubject.get('m1')).toBe('answer_question')
    expect(bySubject.get('m2')).toBe('no_action')
  })

  it('reports the goal, the halt, the settings, and a budget exhausted by supervisor spend alone', async (): Promise<void> => {
    const fixture = await seed({ goal: 'ship checkout', haltedReason: 'budget_exhausted', budgetUsd: 2 })
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { supervisorEnabled: false, supervisorProfile: 'be conservative' },
    })
    await prisma.supervisorDecision.create({
      data: {
        workspaceId: fixture.workspaceId,
        situationKind: 'workspace_halted',
        subjectId: fixture.workspaceId,
        situation: {},
        candidates: [],
        chosenIndex: 0,
        action: { kind: 'no_action' },
        rationale: 'x',
        tier: 'noop',
        status: 'applied',
        decidedBy: 'model',
        modelCalled: true,
        modelCostUsd: 2.5,
      },
    })

    const { world, settings } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.goal).toBe('ship checkout')
    expect(world.halted).toEqual({ reason: 'budget_exhausted' })
    expect(world.budgetExhausted).toBe(true)
    expect(settings).toEqual({ enabled: false, profile: 'be conservative' })
  })

  it('leaves an unbudgeted workspace unexhausted however much it spent', async (): Promise<void> => {
    const fixture = await seed({ budgetUsd: null })
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'succeeded', kind: 'implementation', costUsd: 99 } })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.budgetExhausted).toBe(false)
  })
})

/**
 * M49 R2 (plan erratum E11). ONE count, always, and no rows: the loader's only memory read.
 */
describe('loadSupervisorWorld -- the stale candidates (M49 R2)', () => {
  beforeEach(reset)

  it('counts only the OBSERVATION candidates older than a day, and the Supervisor sees the habit', async (): Promise<void> => {
    const fixture = await seed()
    const longAgo = ago(MEMORY_CANDIDATE_STALE_MS + 60_000)
    for (let index = 0; index < STALE_CANDIDATES_MIN; index += 1) {
      const written = await recordMemory(candidateDraft(fixture.workspaceId, `c${String(index)}`))
      expect(written.ok).toBe(true)
      if (!written.ok) return
      await prisma.memory.update({ where: { id: written.value.id }, data: { createdAt: longAgo } })
    }
    // A fresh one and a verified old one, neither of which is a thing nobody verified in time.
    expect((await recordMemory(candidateDraft(fixture.workspaceId, 'today'))).ok).toBe(true)
    const verified = await recordMemory(candidateDraft(fixture.workspaceId, 'checked'))
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    await prisma.memory.update({
      where: { id: verified.value.id },
      data: { createdAt: longAgo, status: 'verified', verifiedAt: longAgo, verifiedBy: 'human' },
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.staleMemoryCandidates).toBe(STALE_CANDIDATES_MIN)
    expect(observe(world).map((one) => one.kind)).toContain('memory_candidates_piling')
  })

  it('counts nothing, and raises nothing, for a project whose workers have reported nothing', async (): Promise<void> => {
    const fixture = await seed()
    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.staleMemoryCandidates).toBe(0)
    expect(observe(world).map((one) => one.kind)).not.toContain('memory_candidates_piling')
  })
})

describe('the halt the Supervisor sees (erratum E7)', () => {
  beforeEach(reset)

  /** Spends `usd` on a concluded run, which is what a budget guardrail reads. */
  async function spend(fixture: Fixture, usd: number): Promise<void> {
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: `Spender ${String(Math.random()).slice(2)}`, role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'succeeded', kind: 'implementation', costUsd: usd } })
  }

  it('prefers the durable reason when the workspace carries one', async (): Promise<void> => {
    const fixture = await seed({ haltedReason: 'verify command failed: npm test' })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.halted).toEqual({ reason: 'verify command failed: npm test' })
  })

  it('halts on an exhausted budget even though nothing wrote haltedReason', async (): Promise<void> => {
    // The regression this erratum fixes: only an emergency stop (and the pause/verify/merge halts)
    // ever writes `haltedReason`, so a workspace `decide()` had stopped scheduling entirely looked
    // perfectly healthy to the Supervisor -- routine actions applying, the model seam open.
    const fixture = await seed({ budgetUsd: 1 })
    await spend(fixture, 2)

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.halted).toEqual({ reason: 'budget_exhausted' })
    expect(world.budgetExhausted).toBe(true)
  })

  it('halts on the circuit breaker', async (): Promise<void> => {
    const fixture = await seed()
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Unlucky', role: 'backend', runtimeRoles: ['backend'] },
    })
    for (let index = 0; index < 3; index += 1) {
      await prisma.slaveRun.create({
        data: { slaveId: slave.id, status: 'failed', kind: 'implementation', terminalAt: ago(index * 60_000) },
      })
    }

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.halted).toEqual({ reason: 'circuit_breaker' })
  })

  it('does NOT halt on a concurrency cap -- a busy workspace is not a stuck one', async (): Promise<void> => {
    const fixture = await seed()
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { maxConcurrentRuns: 1 } })
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Busy', role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'working', kind: 'implementation' } })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    // `decide()` HAS halted scheduling here (concurrency halts it), and the Supervisor deliberately
    // does not agree: escalating "this workspace is halted" every time it is at its run cap would
    // put a proposal in front of a human for ordinary operation, and freeze every routine action
    // while it did.
    expect(world.halted).toBeNull()
  })

  it('leaves an idle, solvent, unbroken workspace unhalted', async (): Promise<void> => {
    const fixture = await seed({ budgetUsd: 100 })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.halted).toBeNull()
    expect(world.budgetExhausted).toBe(false)
  })
})

describe('workspaceStats', () => {
  beforeEach(reset)

  it('reads the limits, the run counts, the streak and the halt in one go', async (): Promise<void> => {
    const fixture = await seed({ budgetUsd: 5, haltedReason: 'emergency stop' })
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'working', kind: 'implementation' } })
    await prisma.slaveRun.create({
      data: { slaveId: slave.id, status: 'failed', kind: 'implementation', costUsd: 1.25, terminalAt: NOW },
    })

    const snapshot = await workspaceStats(fixture.workspaceId)

    expect(snapshot.limits).toMatchObject({ budgetUsd: 5, maxConcurrentRuns: 3, maxGlobalConcurrentRuns: 6 })
    expect(snapshot.stats).toMatchObject({
      activeRuns: 1,
      spentUsd: 1.25,
      consecutiveFailures: 1,
      emergencyStopped: true,
    })
    expect(snapshot.stats.globalActiveRuns).toBeGreaterThanOrEqual(1)
    expect(snapshot.haltedReason).toBe('emergency stop')
    expect(snapshot.spend.runsMeasuredUsd).toBe(1.25)
  })
})

describe('workspaceSpend', () => {
  beforeEach(reset)

  it('adds measured run spend, measured supervisor spend, and every unmeasured model call at the per-call cap', async (): Promise<void> => {
    const fixture = await seed()
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] },
    })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'succeeded', kind: 'implementation', costUsd: 1.5 } })
    await prisma.slaveRun.create({ data: { slaveId: slave.id, status: 'working', kind: 'implementation', costUsd: null } })

    const decision = {
      workspaceId: fixture.workspaceId,
      situationKind: 'review_cap_blocked' as const,
      subjectId: 'task-1',
      situation: {},
      candidates: [],
      chosenIndex: 0,
      action: { kind: 'no_action' },
      rationale: 'x',
      tier: 'noop' as const,
      status: 'applied' as const,
    }
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'model', modelCalled: true, modelCostUsd: 0.25 },
    })
    // A model call whose cost never came back: charged at the cap, never at zero.
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'model', modelCalled: true, modelCostUsd: null },
    })
    // Erratum E6, and the reason `modelCalled` exists at all: the call was MADE, came back
    // unusable, and the rules chose -- so the row says `rules` while the money was still spent. It
    // is charged exactly like the model row above.
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'rules', modelCalled: true, modelCostUsd: null },
    })
    // A rules decision that called nobody adds nothing.
    await prisma.supervisorDecision.create({
      data: { ...decision, decidedBy: 'rules', modelCalled: false, modelCostUsd: null },
    })

    const spend = await workspaceSpend(fixture.workspaceId)
    expect(spend).toEqual({
      runsMeasuredUsd: 1.5,
      supervisorMeasuredUsd: 0.25,
      supervisorUnmeasuredCalls: 2,
      spentUsd: 1.5 + 0.25 + 2 * SUPERVISOR_PER_CALL_CAP_USD,
    })
  })

  it('reports zeros for a workspace that has spent nothing', async (): Promise<void> => {
    const fixture = await seed()
    expect(await workspaceSpend(fixture.workspaceId)).toEqual({
      runsMeasuredUsd: 0,
      supervisorMeasuredUsd: 0,
      supervisorUnmeasuredCalls: 0,
      spentUsd: 0,
    })
  })
})

/**
 * M47 R4. Three facts the world gained, and the condition under which they are read at all: a
 * project whose board names no capability must cost exactly the queries it cost before this
 * milestone, so `taxonomy`, `company` and `catalog` stay empty for it.
 */
describe('loadSupervisorWorld -- the capability facts (M47 R4)', () => {
  beforeEach(reset)

  it('reads neither the taxonomy, the roster nor the catalog when no task asks for a capability', async () => {
    const f = await seed()
    await makeTask(f, { title: 'plain', status: 'ready' })
    await prisma.slave.create({
      data: { teamId: f.teamId, name: 'Maya', role: 'Engineer', runtimeRoles: ['backend'], capabilities: ['security.application'] },
    })
    await prisma.slaveTemplate.create({
      data: { name: 'M47 World Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })

    const { world } = await loadSupervisorWorld(f.workspaceId, NOW)
    expect(world.taxonomy).toEqual([])
    expect(world.company).toEqual([])
    expect(world.catalog).toEqual([])
    // The per-row facts are carried either way -- they come off rows the loader already reads.
    expect(world.tasks[0]?.requiredCapabilities).toEqual([])
    expect(world.slaves[0]?.capabilities).toEqual(['security.application'])
  })

  it('stops paying for the roster and the catalog once every capability-bearing task is finished', async () => {
    // Fix round 1, Minor 6. The gate is `teamPlanOf`'s own filter: a board with no READY or BLOCKED
    // task asking for anything has no gap to staff, and three queries a tick to answer that is a
    // cost with no answer in it.
    const f = await seed()
    await makeTask(f, { title: 'hardened', status: 'done', requiredCapabilities: ['security.application'] })
    await makeTask(f, { title: 'shipped', status: 'failed', requiredCapabilities: ['security.application'] })
    await prisma.slaveTemplate.create({
      data: { name: 'M47 World Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })

    const { world } = await loadSupervisorWorld(f.workspaceId, NOW)
    expect(world.taxonomy).toEqual([])
    expect(world.company).toEqual([])
    expect(world.catalog).toEqual([])
    // The task's own keys are still carried: they come off a row the loader already reads.
    expect(world.tasks.map((task) => task.requiredCapabilities)).toEqual([
      ['security.application'],
      ['security.application'],
    ])
  })

  // FINAL REVIEW, IMPORTANT 2. This gate used to read `ready || blocked` -- `teamPlanOf`'s old
  // filter -- and the round-1 version of this case asserted the catalog WAS read for a blocked
  // task. `isStaffableTask` is now the one predicate all four readings share, and a blocked task is
  // not yet a staffing need: it is waiting on a guardrail or a human, staffing it unsticks nothing,
  // and `observe` was never going to raise a situation for it anyway. So there is nothing for
  // `formTeam` to be handed a roster and a catalog FOR, and the three queries are not paid.
  it('does not pay for the catalog for a BLOCKED task, which no situation would staff', async () => {
    const f = await seed()
    await makeTask(f, { title: 'stuck', status: 'blocked', requiredCapabilities: ['security.application'] })
    await prisma.slaveTemplate.create({
      data: { name: 'M47 World Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })

    const { world } = await loadSupervisorWorld(f.workspaceId, NOW)
    expect(world.taxonomy).toEqual([])
    expect(world.catalog).toEqual([])
    // The task's own keys still come through: they are on a row the loader already reads.
    expect(world.tasks.map((task) => task.requiredCapabilities)).toEqual([['security.application']])
  })

  it('reads all three the moment one task names a capability, and carries the keys through', async () => {
    const f = await seed()
    await makeTask(f, { title: 'harden', status: 'ready', requiredCapabilities: ['security.application'] })
    const template = await prisma.slaveTemplate.create({
      data: { name: 'M47 World Reviewer', role: 'security', capabilityKeys: ['security.application'], sourceDivision: 'security' },
    })
    // A template that provides nothing can never cover a gap, so it is not in the index.
    await prisma.slaveTemplate.create({ data: { name: 'M47 World Generalist', role: 'backend' } })

    const { world } = await loadSupervisorWorld(f.workspaceId, NOW)
    expect(world.tasks[0]?.requiredCapabilities).toEqual(['security.application'])
    expect(world.taxonomy.find((row) => row.key === 'security.application')?.role).toBe('security')
    expect(world.catalog).toEqual([
      {
        templateId: template.id,
        name: 'M47 World Reviewer',
        capabilities: ['security.application'],
        division: 'security',
        recommended: false,
        // M53 plan erratum E7: a template candidate's model, which this one does not name.
        defaultModel: null,
      },
    ])
  })

  it('offers the company roster minus whoever is already on this project', async () => {
    const f = await seed()
    await makeTask(f, { title: 'harden', status: 'ready', requiredCapabilities: ['security.application'] })
    const template = await prisma.slaveTemplate.create({
      data: { name: 'M47 World Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const company = await prisma.company.create({ data: { name: `M47 World Co ${String(Math.random()).slice(2)}` } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Security' } })
    const here = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Already Here' },
    })
    const notHere = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Sam' },
    })
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { companyId: company.id } })
    await prisma.slave.create({
      data: { teamId: f.teamId, name: 'Already Here', role: 'security', runtimeRoles: [], companySlaveId: here.id },
    })

    const { world } = await loadSupervisorWorld(f.workspaceId, NOW)
    expect(world.company).toEqual([
      // M53 plan erratum E7: `templateId` rides along, because a company worker's profile key is
      // `template:<it>` and `CompanySlave.templateId` is NOT NULL.
      { companySlaveId: notHere.id, name: 'Sam', capabilities: ['security.application'], templateId: template.id },
    ])
  })

  it('marks a template recommended when a worker already here carries a hint pointing at it', async () => {
    const f = await seed()
    await makeTask(f, { title: 'harden', status: 'ready', requiredCapabilities: ['security.application'] })
    const source = await prisma.slaveTemplate.create({
      data: { name: 'M47 World Backend', role: 'backend', capabilityKeys: ['backend.api-design'] },
    })
    const target = await prisma.slaveTemplate.create({
      data: { name: 'M47 World Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    await prisma.collaborationHint.create({
      data: { templateId: source.id, text: 'Ask the Security Reviewer before shipping.', targetTemplateId: target.id },
    })
    await prisma.slave.create({
      data: { teamId: f.teamId, name: 'Maya', role: 'backend', runtimeRoles: ['backend'], hiredFromTemplateId: source.id },
    })

    const { world } = await loadSupervisorWorld(f.workspaceId, NOW)
    expect(world.catalog.find((entry) => entry.templateId === target.id)?.recommended).toBe(true)
    expect(world.catalog.find((entry) => entry.templateId === source.id)?.recommended).toBe(false)
  })
})

describe('loadSupervisorWorld -- the runbook fields (M48 R5, E6, E8)', () => {
  beforeEach(async (): Promise<void> => {
    await reset()
    // `reset()` truncates `SlaveTemplate` CASCADE, which reaches `RunbookTemplate` through
    // `sourceTemplateId`, so the table is reconciled per case rather than once for the file.
    await syncRunbooks()
  })

  it('loads the adopted runbook, the stage escalation and the handoff behind a pending question (M48)', async (): Promise<void> => {
    const fixture = await seed({ goal: 'Ship the checkout endpoint' })
    await adoptRunbook(fixture.workspaceId, 'feature-delivery')
    await makeTask(fixture, { title: 'Prove it', status: 'blocked', stage: 'verify' })
    await makeTask(fixture, { title: 'Build it', status: 'running', stage: 'implement' })
    await makeTask(fixture, { title: 'Typed in by a person', status: 'ready' })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)

    expect(world.runbook?.key).toBe('feature-delivery')
    expect(world.runbook?.stages.map((stage) => stage.key)).toEqual(['design', 'implement', 'verify', 'review', 'release'])
    // A runbook is adopted, so the catalogue is not paid for.
    expect(world.runbooks).toEqual([])
    const verify = world.tasks.find((task) => task.stage === 'verify')
    expect(verify?.stageEscalation).toContain('acceptance criteria')
    // Plan erratum E6: null is the ordinary answer for a stage that sets no escalation, and for a
    // task that carries no stage at all.
    expect(world.tasks.find((task) => task.stage === 'implement')?.stageEscalation).toBeNull()
    const handMade = world.tasks.find((task) => task.title === 'Typed in by a person')
    expect(handMade?.stage).toBeNull()
    expect(handMade?.stageEscalation).toBeNull()
  })

  // M48 final review, Important 1: the taxonomy is loaded whenever RUNBOOKS matter, not only when
  // the board asks for a capability. Both readings of a runbook's capabilities -- the Overview's
  // stage chips and the recommendation's own rationale -- print LABELS, and an empty taxonomy makes
  // them print raw keys. The two states below are exactly the ones a runbook lives in: an adopted
  // runbook with nothing else going on, and a project about to be recommended one.
  it('carries the taxonomy for an adopted runbook on an empty board, where no situation asks for it', async (): Promise<void> => {
    const fixture = await seed({ goal: 'Ship the checkout endpoint' })
    await adoptRunbook(fixture.workspaceId, 'feature-delivery')

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)

    // No task names a capability -- there are no tasks at all -- so this is the M47 gate saying no
    // and the M48 one saying yes.
    expect(world.tasks).toEqual([])
    expect(world.taxonomy.find((row) => row.key === 'security.application')?.label).toBe('Application security')
    // The staffing reads stay behind their own gate: nothing here asks who could be hired.
    expect(world.company).toEqual([])
    expect(world.catalog).toEqual([])
  })

  it('carries the taxonomy while a recommendation could still be made, and drops it once neither holds', async (): Promise<void> => {
    const fixture = await seed({ goal: 'Ship the checkout endpoint' })
    expect((await loadSupervisorWorld(fixture.workspaceId, NOW)).world.taxonomy.length).toBeGreaterThan(0)

    // A board and no runbook: nothing on this project reads a capability by name any more.
    await makeTask(fixture, { title: 'Already planned', status: 'ready' })
    const planned = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(planned.world.runbooks).toEqual([])
    expect(planned.world.taxonomy).toEqual([])
  })

  it('offers the catalogue only when a recommendation could actually be made', async (): Promise<void> => {
    const fixture = await seed({ goal: 'Ship the checkout endpoint' })

    const offered = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(offered.world.runbook).toBeNull()
    expect(offered.world.runbooks.map((runbook) => runbook.key)).toEqual(['bug-fix', 'feature-delivery', 'security-review'])

    // A board is enough to stop the scan: this project has already been planned.
    await makeTask(fixture, { title: 'Already planned', status: 'ready' })
    expect((await loadSupervisorWorld(fixture.workspaceId, NOW)).world.runbooks).toEqual([])
  })

  // Fix round 1, Minor 3: a full catalog import can translate thousands of persona runbooks, and a
  // Supervisor world is built once a tick. Bounded key-ascending, the `CATALOG_ENTRIES_MAX` rule.
  it('offers at most RUNBOOKS_IN_WORLD_MAX of them, key ascending', async (): Promise<void> => {
    const fixture = await seed({ goal: 'Ship the checkout endpoint' })
    const stages = [
      { key: 'only', title: 'Only', objective: 'Do it', capabilities: [], dependsOn: [], expectedOutputs: [], gates: [], retry: null, escalation: null },
    ]
    await prisma.runbookTemplate.createMany({
      data: Array.from({ length: RUNBOOKS_IN_WORLD_MAX + 5 }, (_unused, index) => ({
        key: `bound-${String(index).padStart(4, '0')}`,
        name: `Bound ${String(index)}`,
        description: 'one of many',
        stages,
        source: 'human',
      })),
    })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)

    expect(world.runbooks).toHaveLength(RUNBOOKS_IN_WORLD_MAX)
    const keys = world.runbooks.map((runbook) => runbook.key)
    expect(keys).toEqual(keys.toSorted())
    expect(keys[0]).toBe('bound-0000')

    // This is the file's last block, so its rows would otherwise outlive the run: `reset()` only
    // reaches `RunbookTemplate` at the START of the next case.
    await prisma.runbookTemplate.deleteMany({ where: { key: { startsWith: 'bound-' } } })
  })

  // Fix round 1, Minor 4: the loader coerces a stored `source` the same way `readRunbook` does --
  // one helper, so the panel and the CLI cannot disagree about what a hand-edited row is.
  it('reads a source nothing recognises as human', async (): Promise<void> => {
    const fixture = await seed({ goal: 'Ship the checkout endpoint' })
    await adoptRunbook(fixture.workspaceId, 'feature-delivery')
    await prisma.runbookTemplate.update({ where: { key: 'feature-delivery' }, data: { source: 'imported' } })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.runbook?.source).toBe('human')
  })

  it('offers nothing to a project with no goal to match a runbook against', async (): Promise<void> => {
    const fixture = await seed()
    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.runbooks).toEqual([])
    expect(world.runbook).toBeNull()
  })

  it('carries the asking task\'s handoff behind a pending question, and null for one that will not parse', async (): Promise<void> => {
    const fixture = await seed({ goal: 'ship checkout' })
    const asker = await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Maya', role: 'product', runtimeRoles: ['product'] },
    })
    await prisma.slave.create({
      data: { teamId: fixture.teamId, name: 'Robin', role: 'QA', runtimeRoles: ['reviewer'] },
    })
    const contract = {
      objective: 'Add an authentication path to the orders endpoint.',
      expectedOutput: 'Every orders route requires a signed session.',
      acceptanceCriteria: ['Anonymous requests get 401'],
      knownConstraints: [],
      evidenceRequired: [],
      contextReferences: [],
    }
    const goodTask = await makeTask(fixture, { title: 'Add authentication', status: 'running', handoff: contract })
    const badTask = await makeTask(fixture, { title: 'Nobody can read this', status: 'running', handoff: { objective: 42 } })

    for (const [index, taskId] of [goodTask, badTask].entries()) {
      const run = await prisma.slaveRun.create({
        data: { slaveId: asker.id, status: 'paused', pauseReason: 'waiting_for_answer', kind: 'implementation', taskId },
      })
      await prisma.slaveMessage.create({
        data: {
          slaveId: asker.id,
          workspaceId: fixture.workspaceId,
          taskId,
          senderRunId: run.id,
          recipientRole: 'reviewer',
          threadId: `thread-${String(index)}`,
          kind: 'question',
          body: 'Which session store?',
          actor: 'slave',
          expectsReply: true,
        },
      })
    }

    const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
    expect(world.questions).toHaveLength(2)
    expect(world.questions.find((question) => question.taskId === goodTask)?.taskHandoff).toEqual(contract)
    // A malformed handoff must not take the Supervisor's mailbox down.
    expect(world.questions.find((question) => question.taskId === badTask)?.taskHandoff).toBeNull()
  })

  // M51 R3 / plan erratum E9: the world's first run-derived rows.
  describe('world.runs (M51 R3)', () => {
    it('carries the workspace’s non-terminal runs, and leaves the terminal ones out', async (): Promise<void> => {
      const fixture = await seed()
      const slave = await prisma.slave.create({
        data: { teamId: fixture.teamId, name: 'Alex', role: 'Senior Engineer', runtimeRoles: ['backend'] },
      })
      const taskId = await makeTask(fixture, { title: 'the work', status: 'running' })
      const live = await prisma.slaveRun.create({
        data: { slaveId: slave.id, taskId, status: 'working', kind: 'implementation', toolCalls: 12 },
      })
      await prisma.slaveRun.create({ data: { slaveId: slave.id, taskId, status: 'succeeded', kind: 'implementation' } })

      const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
      expect(world.runs.map((run) => run.id)).toEqual([live.id])
      expect(world.runs[0]).toEqual({
        id: live.id,
        taskId,
        slaveId: slave.id,
        status: 'working',
        toolCalls: 12,
        toolCallCap: null,
        breakerLevel: 'none',
        breakerTrips: 0,
        breakerSteers: 0,
        // A healthy run has no trip to project, and all three are null together.
        trip: null,
        detail: null,
        count: null,
      })
    })

    it('asks the event log NOTHING while every run is at level none', async (): Promise<void> => {
      // The gate the loader is built on: a project that has never tripped the breaker pays exactly
      // the queries it paid before M51. Proved by writing a `run.breaker` row for a run the loader
      // will NOT read the trip of -- if the query ran unconditionally, the trip would appear.
      const fixture = await seed()
      const slave = await prisma.slave.create({
        data: { teamId: fixture.teamId, name: 'Alex', role: 'Senior Engineer', runtimeRoles: [] },
      })
      const run = await prisma.slaveRun.create({
        data: { slaveId: slave.id, status: 'working', kind: 'implementation' },
      })
      await appendEvent({
        type: 'run.breaker',
        workspaceId: fixture.workspaceId,
        slaveId: slave.id,
        runId: run.id,
        actor: 'system',
        payload: { level: 'steered', trip: 'repeated_call', count: 8, detail: 'Bash:abc' },
      })

      const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
      expect(world.runs[0]?.trip).toBeNull()
    })

    it('projects the NEWEST run.breaker onto a steered run, so the Supervisor has a sentence to send', async (): Promise<void> => {
      const fixture = await seed()
      const slave = await prisma.slave.create({
        data: { teamId: fixture.teamId, name: 'Alex', role: 'Senior Engineer', runtimeRoles: [] },
      })
      const run = await prisma.slaveRun.create({
        data: {
          slaveId: slave.id,
          status: 'working',
          kind: 'implementation',
          breakerLevel: 'steered',
          breakerTrips: 1,
        },
      })
      for (const payload of [
        { level: 'steered' as const, trip: 'error_storm' as const, count: 5, detail: 'timeout' },
        { level: 'steered' as const, trip: 'repeated_call' as const, count: 9, detail: 'Bash:abc' },
      ]) {
        await appendEvent({
          type: 'run.breaker',
          workspaceId: fixture.workspaceId,
          slaveId: slave.id,
          runId: run.id,
          actor: 'system',
          payload,
        })
      }

      const { world } = await loadSupervisorWorld(fixture.workspaceId, NOW)
      expect(world.runs[0]).toMatchObject({ trip: 'repeated_call', count: 9, detail: 'Bash:abc' })
      // And the situation the whole projection exists for is now raisable.
      expect(observe(world).map((situation) => situation.kind)).toContain('run_looping')
    })
  })
})

/**
 * M52 R5 / plan erratum E9: `world.denials`, the count behind `permission_blocked`.
 *
 * A real clock rather than this file's fixed `NOW`: the window is measured back from the instant
 * the loader is given, and `appendEvent` stamps `ts` itself, so a fixed clock far in the past puts
 * every row inside the window and the "outside it" case could not be written at all.
 */
describe('loadSupervisorWorld -- the denials (M52 R5)', () => {
  beforeEach(reset)

  async function deny(
    fixture: Fixture,
    slaveId: string,
    runId: string,
    capability: string,
    times = 1,
  ): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await appendEvent({
        type: 'run.tool_denied',
        workspaceId: fixture.workspaceId,
        slaveId,
        runId,
        actor: 'slave',
        payload: { tool: 'WebFetch', capability, toolUseId: `tu-${capability}-${String(index)}` },
      })
    }
  }

  async function liveRun(fixture: Fixture, name: string): Promise<{ slaveId: string; runId: string }> {
    const slave = await prisma.slave.create({
      data: { teamId: fixture.teamId, name, role: 'Senior Engineer', runtimeRoles: ['backend'] },
    })
    const run = await prisma.slaveRun.create({
      data: { slaveId: slave.id, status: 'working', kind: 'implementation' },
    })
    return { slaveId: slave.id, runId: run.id }
  }

  it('counts each worker’s refusals per OPERATION, and keeps the newest run behind them', async (): Promise<void> => {
    const fixture = await seed()
    const alex = await liveRun(fixture, 'Alex')
    const robin = await liveRun(fixture, 'Robin')
    await deny(fixture, alex.slaveId, alex.runId, 'network_fetch', PERMISSION_TRIP_COUNT)
    await deny(fixture, alex.slaveId, alex.runId, 'deploy_release', 1)
    await deny(fixture, robin.slaveId, robin.runId, 'network_fetch', 1)

    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect([...world.denials].sort((a, b) => (a.slaveId + a.kind < b.slaveId + b.kind ? -1 : 1))).toEqual(
      [
        { slaveId: alex.slaveId, kind: 'network_fetch', count: PERMISSION_TRIP_COUNT, latestRunId: alex.runId },
        { slaveId: alex.slaveId, kind: 'deploy_release', count: 1, latestRunId: alex.runId },
        { slaveId: robin.slaveId, kind: 'network_fetch', count: 1, latestRunId: robin.runId },
      ].sort((a, b) => (a.slaveId + a.kind < b.slaveId + b.kind ? -1 : 1)),
    )
    // And only the one that reached the trip count is a wall a person is asked about.
    expect(observe(world).filter((situation) => situation.kind === 'permission_blocked')).toHaveLength(1)
  })

  it('leaves a refusal older than the window out -- a wall met last week is not one now', async (): Promise<void> => {
    const fixture = await seed()
    const alex = await liveRun(fixture, 'Alex')
    await deny(fixture, alex.slaveId, alex.runId, 'network_fetch', 2)
    await prisma.executionEvent.updateMany({
      where: { type: 'run_tool_denied' },
      data: { ts: new Date(Date.now() - PERMISSION_DENIAL_WINDOW_MS - 60_000) },
    })
    await deny(fixture, alex.slaveId, alex.runId, 'network_fetch', 1)

    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.denials).toEqual([
      { slaveId: alex.slaveId, kind: 'network_fetch', count: 1, latestRunId: alex.runId },
    ])
  })

  it('does not count a denial from a run that has since CONCLUDED, even for a worker still working', async (): Promise<void> => {
    // The bound the query is built on (fix round 1, Important 1): `ExecutionEvent` is indexed on
    // `(runId, seq)` and on nothing that could serve `type` or `ts`, so the read is keyed on the
    // live run ids the loader already holds. The narrowing that buys is exactly this case, and it
    // is the docstring's own argument: a wall is one a worker is standing at now.
    const fixture = await seed()
    const alex = await liveRun(fixture, 'Alex')
    const finished = await prisma.slaveRun.create({
      data: { slaveId: alex.slaveId, status: 'failed', kind: 'implementation' },
    })
    await deny(fixture, alex.slaveId, finished.id, 'network_fetch', PERMISSION_TRIP_COUNT)
    await deny(fixture, alex.slaveId, alex.runId, 'network_fetch', 1)

    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.denials).toEqual([
      { slaveId: alex.slaveId, kind: 'network_fetch', count: 1, latestRunId: alex.runId },
    ])
    // And so the wall is not raised off a run nobody is waiting on.
    expect(observe(world).filter((situation) => situation.kind === 'permission_blocked')).toEqual([])
  })

  it('asks the event log NOTHING while no run is live', async (): Promise<void> => {
    // The gate the loader is built on, proved the way the breaker's is: the rows are there, the
    // run that wrote them has concluded, and the count does not appear.
    const fixture = await seed()
    const alex = await liveRun(fixture, 'Alex')
    await deny(fixture, alex.slaveId, alex.runId, 'network_fetch', PERMISSION_TRIP_COUNT)
    await prisma.slaveRun.update({ where: { id: alex.runId }, data: { status: 'succeeded' } })

    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.denials).toEqual([])
  })

  it('carries a pre-M52 capability and an ungoverned tool through unjudged -- the counting is not the judging', async (): Promise<void> => {
    const fixture = await seed()
    const alex = await liveRun(fixture, 'Alex')
    await deny(fixture, alex.slaveId, alex.runId, 'run tests', PERMISSION_TRIP_COUNT)
    await deny(fixture, alex.slaveId, alex.runId, 'ungoverned_tool', PERMISSION_TRIP_COUNT)

    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.denials.map((denial) => denial.kind).sort()).toEqual(['run tests', 'ungoverned_tool'])
    // `observe` is what refuses to put either in front of a person: neither names something a
    // person can grant.
    expect(observe(world).filter((situation) => situation.kind === 'permission_blocked')).toEqual([])
  })
})

/**
 * M53's three bounded loads, against the milestone's own fixture rather than this file's `seed()`:
 * the ranker's world is about a PROFILE, and a profile needs a template, a worker hired from it and
 * a task that asks for a capability -- which is exactly what `seedEvidenceFixture` is.
 */
describe('the world M53 hands the ranker (R8, R9, R10, errata E7/E8)', () => {
  let fixture: EvidenceFixture
  beforeEach(async (): Promise<void> => {
    fixture = await seedEvidenceFixture()
  })

  it('carries each worker DENY rows, and only the denies', async (): Promise<void> => {
    await prisma.slavePermission.create({ data: { slaveId: fixture.slaveId, kind: 'run_commands', mode: 'deny' } })
    await prisma.slavePermission.create({ data: { slaveId: fixture.slaveId, kind: 'read_repo', mode: 'allow' } })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.slaves.find((s) => s.id === fixture.slaveId)?.deniedKinds).toEqual(['run_commands'])
  })

  it('carries the profile key ingredients: the template a worker was hired from, and its resolved model', async (): Promise<void> => {
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    const slave = world.slaves.find((s) => s.id === fixture.slaveId)
    expect(slave?.hiredFromTemplateId).toBe(fixture.templateId)
    expect(slave?.model).toBe('claude-sonnet-4-20250514')
  })

  it('carries the staffing preferences a person set', async (): Promise<void> => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.staffingPreferences).toEqual([
      { capability: 'backend.services', capabilityLabel: BACKEND_SERVICES_LABEL, templateId: null, model: 'opus', setBy: null },
    ])
  })

  it('carries the record of every candidate profile, and of nobody else', async (): Promise<void> => {
    await seedEvidenceRows(fixture, 6)
    await seedEvidenceRows(fixture, [{ profileKey: 'template:nobody-here', profileName: 'Nobody' }])
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    const record = world.evidence.find((one) => one.profileKey === `template:${fixture.templateId}`)
    expect(record?.attempted).toBe(6)
    expect(world.evidence.map((one) => one.profileKey)).not.toContain('template:nobody-here')
  })

  it('reads NOTHING when no staffable task asks for a capability (erratum E8)', async (): Promise<void> => {
    await seedEvidenceRows(fixture, 6)
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    await prisma.slavePermission.create({ data: { slaveId: fixture.slaveId, kind: 'run_commands', mode: 'deny' } })
    await prisma.task.updateMany({ where: { workspaceId: fixture.workspaceId }, data: { requiredCapabilities: [] } })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.evidence).toEqual([])
    expect(world.staffingPreferences).toEqual([])
    expect(world.company).toEqual([])
    expect(world.catalog).toEqual([])
    // ...and the DENIES wait on the same gate (final wave, R10). The only reader of `deniedKinds`
    // is the ranker's permission step, and the ranker runs only where the four above run -- so an
    // ungated load was one indexed query per tick, on every project forever, for a list nobody
    // would read. The deny row above exists and is deliberately not carried here.
    for (const slave of world.slaves) expect(slave.deniedKinds).toEqual([])
  })

  it('reads no denials query at all when the workspace holds no `SlavePermission` row', async (): Promise<void> => {
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    for (const slave of world.slaves) expect(slave.deniedKinds).toEqual([])
  })
})
