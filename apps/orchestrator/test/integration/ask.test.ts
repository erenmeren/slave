import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { ASK_BLOCK_CLOSE, ASK_BLOCK_OPEN, slaveId, runId, taskId, workspaceId } from '@slave-of-ai/domain'
import type { RunOutcome, RuntimeEvent, SlaveRuntimeAdapter } from '@slave-of-ai/providers'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { claimResume, requestResume } from '@slave-of-ai/control'
import { ASK_PAUSE_REASON } from '../../src/ask.js'
import { pumpRun } from '../../src/pump.js'
import { noteTickRan, reconcileOrphans, resetTickObservation, sweep } from '../../src/sweep.js'
import { verifyConcludedRun } from '../../src/verify.js'

/** The adapter hands the pump an async stream; an array is the same contract without a process. */
async function* fromArray(events: readonly RuntimeEvent[]): AsyncIterable<RuntimeEvent> {
  for (const event of events) {
    yield event
    await Promise.resolve()
  }
}

const okOutcome: RunOutcome = {
  isError: false,
  terminalReason: 'completed',
  stopReason: null,
  numTurns: 3,
  costUsd: 0.05,
  deniedToolUseIds: [],
  tokens: null,
}

const erroredOutcome: RunOutcome = { ...okOutcome, isError: true, terminalReason: 'the model gave up' }

const ask = (json: string): string => `${ASK_BLOCK_OPEN}${json}${ASK_BLOCK_CLOSE}`

/** A real worktree, so `writeCheckpoint`'s `git rev-parse HEAD` reads a real commit rather than
 *  warning its way to an empty string -- the checkpoint this task writes is the thing under test. */
let worktreePath = ''

/** A pid that genuinely does not exist: a real child, spawned and reaped -- the shape a run whose
 *  process has finished reporting leaves behind, and the shape the orphan sweep hunts. */
let DEAD_PID = 0

/** The sweep resolves an adapter per run and only ever calls `cancel`; nothing here reaches it. */
const registry = {
  resolve: (): SlaveRuntimeAdapter =>
    ({ cancel: async (): Promise<void> => {} }) as unknown as SlaveRuntimeAdapter,
}

beforeAll(async (): Promise<void> => {
  const child = spawnChild('/bin/sh', ['-c', 'exit 0'])
  DEAD_PID = child.pid ?? 0
  await new Promise<void>((resolve) => child.on('exit', () => resolve()))
  worktreePath = mkdtempSync(`${tmpdir()}/slaveofai-ask-`)
  const git = (...args: readonly string[]): void => {
    execFileSync('git', [...args], {
      cwd: worktreePath,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Alex', GIT_AUTHOR_EMAIL: 'alex@slaveofai.local', GIT_COMMITTER_NAME: 'Alex', GIT_COMMITTER_EMAIL: 'alex@slaveofai.local' },
    })
  }
  git('init', '--quiet')
  git('commit', '--allow-empty', '-m', 'root')
})

afterAll(async (): Promise<void> => {
  rmSync(worktreePath, { recursive: true, force: true })
  await prisma.$disconnect()
})

interface Ids {
  readonly runId: ReturnType<typeof runId>
  readonly taskId: ReturnType<typeof taskId>
  readonly slaveId: ReturnType<typeof slaveId>
  readonly workspaceId: ReturnType<typeof workspaceId>
  readonly cancel: () => Promise<void>
}

interface Fixture extends Ids {
  /** The slave that can answer: a different worker, in the same workspace, holding `answerer`. */
  readonly answererId: string
  readonly otherWorkspaceSlaveId: string
}

const spawn = {
  settingsPath: '/tmp/settings.json',
  pauseFlagPath: '/tmp/pause.flag',
  hookPath: '/tmp/pause-gate.sh',
  gitIdentity: { name: 'Alex', email: 'alex@slaveofai.local' },
} as const

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    // `true` as the verify command, and the temp worktree as the repo: the resume test below runs
    // the REAL `verifyConcludedRun` on the resumed run, and a verify pass has to be able to pass.
    data: { name: 'Checkout Platform', repoPath: worktreePath, verifyCommands: ['true'], setupCommands: [] },
  })
  const other = await prisma.workspace.create({
    data: { name: 'Other Platform', repoPath: '/tmp/other', verifyCommands: ['npm test'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend', runtimeRoles: ['backend'] } })
  // Titles that are NOT the runtime role (M37 t3): `recipientCanAnswer` counts holders by
  // `runtimeRoles`, so a fixture where the two agreed would pass whichever column it read.
  const answerer = await prisma.slave.create({ data: { teamId: team.id, name: 'Maya', role: 'Product Lead', runtimeRoles: ['answerer'] } })
  const outsider = await prisma.slave.create({ data: { teamId: otherTeam.id, name: 'Zoe', role: 'Product Lead', runtimeRoles: ['answerer'] } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add checkout retry',
      description: 'retry failed payments',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: workspace.maxAttempts,
      // What the tick writes at provisioning; `verifyConcludedRun` refuses to advance a task with
      // no branch recorded.
      branch: 'slave/add-checkout-retry',
    },
  })
  const run = await prisma.slaveRun.create({
    data: { taskId: task.id, slaveId: slave.id, status: 'starting', worktreePath, pid: DEAD_PID },
  })
  // What `tick.ts`'s `startRun` does at dispatch, and what every task-side guard here is written
  // against: `activeRunId` is how a release (or this task's park) knows the task is this run's.
  await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })

  return {
    runId: runId(run.id),
    taskId: taskId(task.id),
    slaveId: slaveId(slave.id),
    workspaceId: workspaceId(workspace.id),
    answererId: answerer.id,
    otherWorkspaceSlaveId: outsider.id,
    cancel: async (): Promise<void> => {},
  }
}

async function eventTypesFor(forRunId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { runId: forRunId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

/** One clean run whose final message ends with `text`. */
async function pumpEndingWith(ids: Ids, text: string, outcome: RunOutcome = okOutcome): Promise<RunOutcome | null> {
  return pumpRun({
    runId: ids.runId,
    taskId: ids.taskId,
    slaveId: ids.slaveId,
    workspaceId: ids.workspaceId,
    cancel: ids.cancel,
    spawn,
    events: fromArray([
      { kind: 'session_started', sessionId: 's-1' },
      { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Read', summary: 'Read queue.ts' },
      { kind: 'text', text },
      { kind: 'terminated', outcome },
    ]),
  })
}

describe('a slave that asks, and waits', () => {
  let ids: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SlaveMessage", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    resetTickObservation()
    ids = await seed()
  })

  it('parks the task waiting, pauses the run and writes the question -- charging no attempt', async (): Promise<void> => {
    const outcome = await pumpEndingWith(
      ids,
      `I cannot pick a queue on my own.\n\n${ask('{"role":"answerer","question":"Which queue should retries land on?","context":"The task says retry, not where."}')}`,
    )

    // Not a success: the run did not conclude, it stopped to wait.
    expect(outcome).toBeNull()

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('paused')
    expect(run.pauseReason).toBe('waiting_for_answer')
    expect(run.endedAt).toBeNull()
    expect(run.terminalAt).toBeNull()
    expect(run.pausedAtStep).toBe(1)
    // Final review: the child has already exited by the time this path runs, so the pid it left
    // behind names a process that is gone -- and pids are recycled. Kept, `requestResume`'s
    // `isAlive(run.pid)` could refuse `run_still_stopping` and never deliver the answer.
    expect(run.pid).toBeNull()

    const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    expect(task.status).toBe('waiting')
    // Asking is not failing: no attempt is charged, and the task still belongs to this run --
    // Task 3 resumes THIS run, so `activeRunId` must not be released the way a failure releases it.
    expect(task.attempt).toBe(0)
    expect(task.activeRunId).toBe(ids.runId)

    const message = await prisma.slaveMessage.findFirstOrThrow({ where: { senderRunId: ids.runId } })
    expect(message.kind).toBe('question')
    expect(message.expectsReply).toBe(true)
    expect(message.recipientRole).toBe('answerer')
    expect(message.recipientSlaveId).toBeNull()
    expect(message.slaveId).toBe(ids.slaveId)
    expect(message.workspaceId).toBe(ids.workspaceId)
    expect(message.taskId).toBe(ids.taskId)
    expect(message.body).toContain('Which queue should retries land on?')
    expect(message.body).toContain('The task says retry, not where.')

    const types = await eventTypesFor(ids.runId)
    expect(types).toContain('run.paused')
    expect(types).toContain('slave.message_sent')
    expect(types).not.toContain('run.succeeded')
    expect(types).not.toContain('run.failed')
  })

  it('writes a checkpoint a fresh process could resume from, and both rows survive a cold read', async (): Promise<void> => {
    await pumpEndingWith(ids, ask('{"slaveId":"__ANSWERER__","question":"Is the schema frozen?"}').replace('__ANSWERER__', ids.answererId))

    // Read back through a fresh query, the way a restarted daemon would: a waiting task and its
    // checkpoint are rows, not in-process state.
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: ids.runId } })
    expect(checkpoint.sessionId).toBe('s-1')
    expect(checkpoint.worktreePath).toBe(worktreePath)
    expect(checkpoint.settingsPath).toBe(spawn.settingsPath)
    expect(checkpoint.pauseFlagPath).toBe(spawn.pauseFlagPath)
    expect(checkpoint.hookPath).toBe(spawn.hookPath)
    expect(checkpoint.gitAuthorName).toBe('Alex')
    expect(checkpoint.gitAuthorEmail).toBe('alex@slaveofai.local')
    expect(checkpoint.numTurns).toBe(1)
    expect(checkpoint.headCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(checkpoint.pauseReason).toBe(ASK_PAUSE_REASON)

    const message = await prisma.slaveMessage.findFirstOrThrow({ where: { senderRunId: ids.runId } })
    expect(message.recipientSlaveId).toBe(ids.answererId)
    expect(message.recipientRole).toBeNull()
  })

  it('survives the reaction every caller chains onto the pump: verify leaves a waiting run alone', async (): Promise<void> => {
    await pumpEndingWith(ids, ask('{"role":"answerer","question":"Which queue?"}'))

    // `tick.ts` chains this onto every pump. A `paused` run is not terminal, so there is nothing
    // to verify, nothing to release and no attempt to charge -- the run is mid-session, waiting.
    await verifyConcludedRun(ids.runId)

    const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    expect(task.status).toBe('waiting')
    expect(task.attempt).toBe(0)
    expect(task.activeRunId).toBe(ids.runId)
    expect(await prisma.artifact.count({ where: { taskId: ids.taskId } })).toBe(0)
  })

  it('is not swept as an orphan: neither the restart pass nor the per-tick pass touches it', async (): Promise<void> => {
    await pumpEndingWith(ids, ask('{"role":"answerer","question":"Which queue?"}'))

    const deps = { workspaceId: ids.workspaceId, registry }
    // The startup pass first -- a waiting run has no process, which is exactly the orphan shape.
    expect(await reconcileOrphans(deps)).toBe(0)
    noteTickRan()
    const report = await sweep(deps)
    expect(report.deadPids).toEqual([])
    expect(report.timedOut).toEqual([])

    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('paused')
    const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    expect(task.status).toBe('waiting')
    expect(task.activeRunId).toBe(ids.runId)
  })

  it('writes one question when the same conclusion is pumped twice', async (): Promise<void> => {
    const text = ask('{"role":"answerer","question":"Which queue?"}')
    await pumpEndingWith(ids, text)
    // The second pump finds a run that is already `paused`, not `working`: somebody else owns this
    // run's outcome now, and a second question would be a duplicate nobody asked for.
    await pumpEndingWith(ids, text)

    expect(await prisma.slaveMessage.count({ where: { senderRunId: ids.runId } })).toBe(1)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    expect(task.status).toBe('waiting')
    expect(task.attempt).toBe(0)
  })

  it('asks again when the RESUMED run hits a second wall -- one run, two questions', async (): Promise<void> => {
    await pumpEndingWith(ids, ask('{"role":"answerer","question":"Which queue should retries land on?"}'))

    // What `executeResume` does before it pumps again (`tick.ts` claims paused -> resuming;
    // `session_started` on the resumed stream writes `working`). The second pump is a SECOND
    // `pumpRun` on the same row -- the case an idempotency key derived from the run id alone would
    // have swallowed, parking the task to wait for a question nobody was ever asked.
    await prisma.slaveRun.update({ where: { id: ids.runId }, data: { status: 'resuming' } })
    await prisma.task.update({ where: { id: ids.taskId }, data: { status: 'running' } })
    await pumpRun({
      runId: ids.runId,
      taskId: ids.taskId,
      slaveId: ids.slaveId,
      workspaceId: ids.workspaceId,
      cancel: ids.cancel,
      spawn,
      resumed: true,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'tool_call', toolUseId: 'tu_2', toolName: 'Read', summary: 'Read retry.ts' },
        { kind: 'text', text: ask('{"role":"answerer","question":"And how many times should it retry?"}') },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    const bodies = (
      await prisma.slaveMessage.findMany({ where: { senderRunId: ids.runId }, orderBy: { seq: 'asc' } })
    ).map((m) => m.body)
    expect(bodies).toEqual(['Which queue should retries land on?', 'And how many times should it retry?'])
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('paused')
    expect(run.pauseReason).toBe('waiting_for_answer')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })).status).toBe('waiting')
  })

  describe('an ask that is not one concludes the run exactly as it would have without it', () => {
    const expectOrdinaryConclusion = async (fixture: Fixture, status: 'succeeded' | 'failed'): Promise<void> => {
      const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.runId } })
      expect(run.status).toBe(status)
      expect(run.endedAt).not.toBeNull()
      expect(run.pauseReason).toBeNull()
      expect(await prisma.slaveMessage.count({ where: { senderRunId: fixture.runId } })).toBe(0)
      expect(await prisma.checkpoint.count({ where: { runId: fixture.runId } })).toBe(0)
      const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
      expect(task.status).not.toBe('waiting')
    }

    it('a malformed block on a clean run still succeeds', async (): Promise<void> => {
      const outcome = await pumpEndingWith(ids, ask('who owns the retry queue?'))
      expect(outcome).not.toBeNull()
      await expectOrdinaryConclusion(ids, 'succeeded')
      expect(await eventTypesFor(ids.runId)).toContain('run.succeeded')
    })

    it('a well-formed block on an ERRORED run still fails, and charges its attempt', async (): Promise<void> => {
      await pumpEndingWith(ids, ask('{"role":"answerer","question":"Which queue?"}'), erroredOutcome)
      await expectOrdinaryConclusion(ids, 'failed')
      expect(await eventTypesFor(ids.runId)).toContain('run.failed')

      // And the M35 release still happens on the caller's side of the chain: the ask path did not
      // intercept a failure on its way to `releaseTaskAfterFailure`.
      await verifyConcludedRun(ids.runId)
      const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
      expect(task.status).toBe('rework')
      expect(task.attempt).toBe(1)
      expect(task.activeRunId).toBeNull()
    })

    it('no block at all still succeeds', async (): Promise<void> => {
      await pumpEndingWith(ids, 'Done: the retries now land on the existing queue.')
      await expectOrdinaryConclusion(ids, 'succeeded')
    })

    it('a recipient in another workspace is not a recipient', async (): Promise<void> => {
      await pumpEndingWith(ids, ask(`{"slaveId":"${ids.otherWorkspaceSlaveId}","question":"Which queue?"}`))
      await expectOrdinaryConclusion(ids, 'succeeded')
    })

    it('a role nobody in the workspace holds is not a recipient', async (): Promise<void> => {
      await pumpEndingWith(ids, ask('{"role":"nobody-holds-this","question":"Which queue?"}'))
      await expectOrdinaryConclusion(ids, 'succeeded')
    })

    it('a slave that does not exist is not a recipient', async (): Promise<void> => {
      await pumpEndingWith(ids, ask('{"slaveId":"00000000-0000-0000-0000-000000000000","question":"Which queue?"}'))
      await expectOrdinaryConclusion(ids, 'succeeded')
    })

    it('the asker itself is not a recipient -- nobody would ever see it, and the task would wait forever', async (): Promise<void> => {
      await pumpEndingWith(ids, ask(`{"slaveId":"${ids.slaveId}","question":"Which queue?"}`))
      await expectOrdinaryConclusion(ids, 'succeeded')
    })

    it('a TITLE somebody holds is not a role (M37 t3)', async (): Promise<void> => {
      // "Product Lead" is Maya's `Slave.role`. Role addressing is `runtimeRoles`, so nobody holds
      // it and the ask reaches nobody -- the run concludes as though it had never asked.
      await pumpEndingWith(ids, ask('{"role":"Product Lead","question":"Which queue?"}'))
      await expectOrdinaryConclusion(ids, 'succeeded')
    })

    it('a role only the asker itself holds is not a recipient either', async (): Promise<void> => {
      // `listMessagesForSlave` never hands a slave its own send, so a role broadcast the asker is
      // the only holder of reaches nobody at all.
      await pumpEndingWith(ids, ask('{"role":"backend","question":"Which queue?"}'))
      await expectOrdinaryConclusion(ids, 'succeeded')
    })
  })

  it('does not park a run that never reached working: nothing else owns a run that never started', async (): Promise<void> => {
    const outcome = await pumpRun({
      runId: ids.runId,
      taskId: ids.taskId,
      slaveId: ids.slaveId,
      workspaceId: ids.workspaceId,
      cancel: ids.cancel,
      spawn,
      // No `session_started`, so the row is still `starting` -- `pump.ts` writes `working` there
      // and nowhere else. The status guard is what refuses this one, before any recipient is read.
      events: fromArray([
        { kind: 'text', text: ask('{"role":"answerer","question":"Which queue?"}') },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })
    expect(outcome).not.toBeNull()
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('succeeded')
    const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    expect(task.status).not.toBe('waiting')
    expect(await prisma.slaveMessage.count({ where: { senderRunId: ids.runId } })).toBe(0)
  })

  it('does not park a run nothing could resume: no spawn facts means no checkpoint', async (): Promise<void> => {
    // The live shape of `writeCheckpoint`'s refusal on a run that DID reach `working`: a caller
    // with no spawn facts (a test fixture, a future caller that never pauses) cannot support a
    // resume, so parking here would leave a task waiting on an answer nothing could deliver.
    const outcome = await pumpRun({
      runId: ids.runId,
      taskId: ids.taskId,
      slaveId: ids.slaveId,
      workspaceId: ids.workspaceId,
      cancel: ids.cancel,
      // No `spawn`, deliberately.
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'text', text: ask('{"role":"answerer","question":"Which queue?"}') },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })

    expect(outcome).not.toBeNull()
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: ids.runId } })
    expect(run.status).toBe('succeeded')
    expect(run.pauseReason).toBeNull()
    expect(await prisma.checkpoint.count({ where: { runId: ids.runId } })).toBe(0)
    expect(await prisma.slaveMessage.count({ where: { senderRunId: ids.runId } })).toBe(0)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })).status).not.toBe('waiting')
  })

  it('refuses an ask from a REVIEW run: a question nobody could ever answer is not asked at all', async (): Promise<void> => {
    // The shape `verify.ts` leaves behind when a run passes: the task is `reviewing`, and its
    // `activeRunId` is null because only `tick.ts`'s `startRun` ever writes that column. A review
    // run parked here would leave the task `reviewing` -- which `deliverAnswers` refuses to deliver
    // to -- while `dispatchReview`'s "already live" gate counted the paused run as live and
    // dispatched no replacement. Refused instead, and the review concludes the ordinary way.
    await prisma.task.update({ where: { id: ids.taskId }, data: { status: 'reviewing', activeRunId: null } })
    const reviewRun = await prisma.slaveRun.create({
      data: { taskId: ids.taskId, slaveId: ids.slaveId, status: 'starting', kind: 'review', worktreePath, pid: DEAD_PID },
    })

    const outcome = await pumpEndingWith(
      { ...ids, runId: runId(reviewRun.id) },
      `I need to know the policy first.\n\n${ask('{"role":"answerer","question":"Which queue should retries land on?"}')}`,
    )

    // An ordinary conclusion, in every particular: nothing parked, nothing asked, nothing to resume.
    expect(outcome).not.toBeNull()
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: reviewRun.id } })
    expect(run.status).toBe('succeeded')
    expect(run.pauseReason).toBeNull()
    expect(run.endedAt).not.toBeNull()
    expect(await prisma.slaveMessage.count({ where: { senderRunId: reviewRun.id } })).toBe(0)
    expect(await prisma.checkpoint.count({ where: { runId: reviewRun.id } })).toBe(0)
    const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    expect(task.status).toBe('reviewing')
    expect(task.attempt).toBe(0)
  })

  it('is reclaimed by the resume that answers it, and then finishes normally', async (): Promise<void> => {
    await pumpEndingWith(ids, ask('{"role":"answerer","question":"Which queue should retries land on?"}'))

    // The real path Task 3's delivery will take: record the answer as the resume intent, then let
    // the process that owns a child claim it (`tick.ts`'s resume pass calls exactly this).
    const requested = await requestResume(ids.runId, 'payments-retry', 'maya')
    expect(requested.ok).toBe(true)
    const claim = await claimResume(ids.runId)
    expect(claim).toEqual({ claimed: true, queuedMessage: 'payments-retry' })

    // The task is back in the scheduler's world as the running task it was, still owned by this
    // run -- without this, everything below concludes into a task nothing can advance.
    const claimed = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    expect(claimed.status).toBe('running')
    expect(claimed.activeRunId).toBe(ids.runId)
    expect(claimed.attempt).toBe(0)

    // The resumed session finishes the work.
    await pumpRun({
      runId: ids.runId,
      taskId: ids.taskId,
      slaveId: ids.slaveId,
      workspaceId: ids.workspaceId,
      cancel: ids.cancel,
      spawn,
      resumed: true,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'text', text: 'Done: retries land on payments-retry.' },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })
    await verifyConcludedRun(ids.runId)

    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: ids.runId } })).status).toBe('succeeded')
    const task = await prisma.task.findUniqueOrThrow({ where: { id: ids.taskId } })
    // Advanced, not ignored: `ADVANCEABLE` never included `waiting`, so a task left there would
    // have sat forever with `activeRunId` pointing at a terminal run.
    expect(task.status).toBe('reviewing')
    expect(task.attempt).toBe(0)
  })
})
