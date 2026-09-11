import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { answerQuestion, claimResume, listPendingQuestions, requestResume } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import {
  ANSWER_BLOCK_CLOSE,
  ANSWER_BLOCK_OPEN,
  ASK_BLOCK_CLOSE,
  ASK_BLOCK_OPEN,
  SECTION_ORDER,
  runId,
  slaveId,
  taskId,
  workspaceId,
  type RunId,
  type SlaveId,
  type TaskId,
  type WorkspaceId,
} from '@slave-of-ai/domain'
import type { RunOutcome, RuntimeEvent } from '@slave-of-ai/providers'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { deliverAnswers } from '../../src/deliver.js'
import { askProtocolSection, inboxSection, rosterSection } from '../../src/inbox.js'
import { pumpRun } from '../../src/pump.js'

/**
 * The message ids one slave's next run would carry, the way `RunContext`'s `inbox` section source
 * records them (M37 t2). `pendingInbox`'s `{ section, messageIds }` pair became one `Section`, and
 * "nothing pending" became `null` rather than a pair of empties.
 */
async function inboxIds(slaveId: string): Promise<readonly string[]> {
  const section = await inboxSection(slaveId)
  if (section === null || section.source.kind !== 'inbox') return []
  return section.source.messageIds
}

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

const ask = (json: string): string => `${ASK_BLOCK_OPEN}${json}${ASK_BLOCK_CLOSE}`
const answer = (json: string): string => `${ANSWER_BLOCK_OPEN}${json}${ANSWER_BLOCK_CLOSE}`

/** A real worktree, so the ask path's `writeCheckpoint` reads a real `git rev-parse HEAD`. */
let worktreePath = ''
let DEAD_PID = 0

const spawn = {
  settingsPath: '/tmp/settings.json',
  pauseFlagPath: '/tmp/pause.flag',
  hookPath: '/tmp/pause-gate.sh',
  gitIdentity: { name: 'Alex', email: 'alex@slaveofai.local' },
} as const

beforeAll(async (): Promise<void> => {
  const child = spawnChild('/bin/sh', ['-c', 'exit 0'])
  DEAD_PID = child.pid ?? 0
  await new Promise<void>((resolve) => child.on('exit', () => resolve()))
  worktreePath = mkdtempSync(`${tmpdir()}/slaveofai-answer-`)
  const git = (...args: readonly string[]): void => {
    execFileSync('git', [...args], {
      cwd: worktreePath,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Alex',
        GIT_AUTHOR_EMAIL: 'alex@slaveofai.local',
        GIT_COMMITTER_NAME: 'Alex',
        GIT_COMMITTER_EMAIL: 'alex@slaveofai.local',
      },
    })
  }
  git('init', '--quiet')
  git('commit', '--allow-empty', '-m', 'root')
})

afterAll(async (): Promise<void> => {
  rmSync(worktreePath, { recursive: true, force: true })
  await prisma.$disconnect()
})

interface Runner {
  readonly runId: RunId
  readonly taskId: TaskId
  readonly slaveId: SlaveId
}

interface Fixture {
  readonly workspaceId: WorkspaceId
  /** The slave that asks, and the run/task that park waiting. */
  readonly alex: Runner
  /** A SECOND asker with its own waiting run -- the "and no other" half of the first test. */
  readonly sam: Runner
  /** The slave that answers, and a run of its own to answer from. */
  readonly maya: Runner
  /** A SECOND holder of the `answerer` role: a role-addressed question reaches both of them, and
   *  both can conclude with a real answer in the same window. */
  readonly nina: Runner
  /** A question in ANOTHER workspace, invisible to everyone above. */
  readonly foreignQuestionId: string
}

async function makeRunner(
  workspace: { readonly id: string; readonly maxAttempts: number },
  teamId: string,
  name: string,
  role: string,
): Promise<Runner> {
  const slave = await prisma.slave.create({ data: { teamId, name, role, runtimeRoles: [role] } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: `${name}'s task`,
      description: 'do the thing',
      status: 'running',
      requiredRole: role,
      maxAttempts: workspace.maxAttempts,
      branch: `slaveofai/${name.toLowerCase()}`,
    },
  })
  const run = await prisma.slaveRun.create({
    data: { taskId: task.id, slaveId: slave.id, status: 'starting', worktreePath, pid: DEAD_PID },
  })
  await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })
  return { runId: runId(run.id), taskId: taskId(task.id), slaveId: slaveId(slave.id) }
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: worktreePath, verifyCommands: ['true'], setupCommands: [] },
  })
  const other = await prisma.workspace.create({
    data: { name: 'Other Platform', repoPath: '/tmp/other', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'Engineering' } })

  const alex = await makeRunner(workspace, team.id, 'Alex', 'backend')
  const sam = await makeRunner(workspace, team.id, 'Sam', 'frontend')
  const maya = await makeRunner(workspace, team.id, 'Maya', 'answerer')
  const nina = await makeRunner(workspace, team.id, 'Nina', 'answerer')

  // A question in the other workspace, addressed to a role Maya also holds -- the cross-workspace
  // boundary is the only thing that can refuse it.
  const zoe = await prisma.slave.create({ data: { teamId: otherTeam.id, name: 'Zoe', role: 'backend', runtimeRoles: ['backend'] } })
  const zoeRun = await prisma.slaveRun.create({ data: { slaveId: zoe.id, status: 'working', kind: 'planning' } })
  const foreign = await prisma.slaveMessage.create({
    data: {
      slaveId: zoe.id,
      workspaceId: other.id,
      senderRunId: zoeRun.id,
      recipientRole: 'answerer',
      threadId: 'foreign-thread',
      kind: 'question',
      body: 'Which queue?',
      actor: 'slave',
      expectsReply: true,
    },
  })

  return { workspaceId: workspaceId(workspace.id), alex, sam, maya, nina, foreignQuestionId: foreign.id }
}

/** One clean run on `runner` whose final message ends with `text`. */
async function pumpEndingWith(runner: Runner, wsId: WorkspaceId, text: string): Promise<RunOutcome | null> {
  return pumpRun({
    runId: runner.runId,
    taskId: runner.taskId,
    slaveId: runner.slaveId,
    workspaceId: wsId,
    cancel: async (): Promise<void> => {},
    spawn,
    events: fromArray([
      { kind: 'session_started', sessionId: `s-${runner.runId}` },
      { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Read', summary: 'Read queue.ts' },
      { kind: 'text', text },
      { kind: 'terminated', outcome: okOutcome },
    ]),
  })
}

/** Parks `runner` waiting on a question addressed to Maya's role, and returns the question's id. */
async function askAndWait(fixture: Fixture, runner: Runner, question: string): Promise<string> {
  await pumpEndingWith(runner, fixture.workspaceId, ask(JSON.stringify({ role: 'answerer', question })))
  const message = await prisma.slaveMessage.findFirstOrThrow({
    where: { senderRunId: runner.runId, kind: 'question' },
    orderBy: { seq: 'desc' },
  })
  return message.id
}

async function eventTypesFor(forRunId: string): Promise<readonly DomainEventType[]> {
  const rows = await prisma.executionEvent.findMany({ where: { runId: forRunId }, orderBy: { seq: 'asc' } })
  return rows.map((row): DomainEventType => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] as DomainEventType)
}

describe('a slave answers, and the asker resumes', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SlaveMessage", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  describe('the answerer writes the answer at its own run conclusion', () => {
    it('replies in the question thread, addressed to the asker, and still concludes its own run', async () => {
      const questionId = await askAndWait(fixture, fixture.alex, 'Which queue should retries land on?')

      const outcome = await pumpEndingWith(
        fixture.maya,
        fixture.workspaceId,
        `Looked it up.\n\n${answer(JSON.stringify({ messageId: questionId, answer: 'payments-retry' }))}`,
      )

      // Answering is an ordinary conclusion for the ANSWERER: its own task proceeds as usual.
      expect(outcome).not.toBeNull()
      const mayaRun = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.maya.runId } })
      expect(mayaRun.status).toBe('succeeded')

      const row = await prisma.slaveMessage.findFirstOrThrow({ where: { kind: 'answer' } })
      expect(row.replyToId).toBe(questionId)
      expect(row.slaveId).toBe(fixture.maya.slaveId)
      expect(row.senderRunId).toBe(fixture.maya.runId)
      expect(row.recipientSlaveId).toBe(fixture.alex.slaveId)
      expect(row.body).toBe('payments-retry')
      expect(row.actor).toBe('slave')
      const question = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: questionId } })
      expect(row.threadId).toBe(question.threadId)
      expect(await eventTypesFor(fixture.maya.runId)).toContain('slave.message_sent')
    })

    it('answers two pending questions in one run', async () => {
      const first = await askAndWait(fixture, fixture.alex, 'Which queue?')
      const second = await askAndWait(fixture, fixture.sam, 'How many retries?')

      await pumpEndingWith(
        fixture.maya,
        fixture.workspaceId,
        `${answer(JSON.stringify({ messageId: first, answer: 'payments-retry' }))}\n${answer(JSON.stringify({ messageId: second, answer: 'three' }))}`,
      )

      const answers = await prisma.slaveMessage.findMany({ where: { kind: 'answer' }, orderBy: { seq: 'asc' } })
      expect(answers.map((row) => row.replyToId)).toEqual([first, second])
    })

    it('answers AND asks in the same run -- the answer is written, then the run parks waiting', async () => {
      const questionId = await askAndWait(fixture, fixture.alex, 'Which queue?')

      await pumpEndingWith(
        fixture.maya,
        fixture.workspaceId,
        `${answer(JSON.stringify({ messageId: questionId, answer: 'payments-retry' }))}\n${ask('{"role":"backend","question":"And who owns the DLQ?"}')}`,
      )

      expect(await prisma.slaveMessage.count({ where: { kind: 'answer', replyToId: questionId } })).toBe(1)
      const mayaRun = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.maya.runId } })
      expect(mayaRun.status).toBe('paused')
      expect(mayaRun.pauseReason).toBe('waiting_for_answer')
    })

    it('writes ONE answer when the same conclusion is pumped twice', async () => {
      const questionId = await askAndWait(fixture, fixture.alex, 'Which queue?')
      const text = answer(JSON.stringify({ messageId: questionId, answer: 'payments-retry' }))
      await pumpEndingWith(fixture.maya, fixture.workspaceId, text)
      await pumpEndingWith(fixture.maya, fixture.workspaceId, text)

      expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(1)
    })

    it('refuses to answer a question addressed to somebody else', async () => {
      // Alex's question names the `answerer` role; Sam holds `frontend` and was never addressed.
      const questionId = await askAndWait(fixture, fixture.alex, 'Which queue?')

      const outcome = await pumpEndingWith(
        fixture.sam,
        fixture.workspaceId,
        answer(JSON.stringify({ messageId: questionId, answer: 'I have no idea' })),
      )

      expect(outcome).not.toBeNull()
      expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(0)
    })

    it('refuses a slave whose TITLE is the addressed role but whose runtime roles are not (M37 t3)', async () => {
      // Sam is retitled "answerer" and keeps `runtimeRoles: ['frontend']`. Role addressing is
      // `runtimeRoles` on both sides -- the inbox never showed Sam this question, so answering it
      // must be refused too, or a slave could close a wait it was never asked to.
      await prisma.slave.update({ where: { id: fixture.sam.slaveId }, data: { role: 'answerer' } })
      const questionId = await askAndWait(fixture, fixture.alex, 'Which queue?')

      const outcome = await pumpEndingWith(
        fixture.sam,
        fixture.workspaceId,
        answer(JSON.stringify({ messageId: questionId, answer: 'I have no idea' })),
      )

      expect(outcome).not.toBeNull()
      expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(0)
    })

    it('refuses to answer a question in another workspace', async () => {
      const outcome = await pumpEndingWith(
        fixture.maya,
        fixture.workspaceId,
        answer(JSON.stringify({ messageId: fixture.foreignQuestionId, answer: 'payments-retry' })),
      )

      expect(outcome).not.toBeNull()
      expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(0)
    })

    it('concludes the ordinary way for a message id nobody wrote, and for a malformed block', async () => {
      await pumpEndingWith(
        fixture.maya,
        fixture.workspaceId,
        `${answer('{"messageId":"00000000-0000-0000-0000-000000000000","answer":"x"}')}\n${answer('not json')}`,
      )

      expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(0)
      const mayaRun = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.maya.runId } })
      expect(mayaRun.status).toBe('succeeded')
    })
  })

  describe("the recipient's inbox", () => {
    it('carries an unanswered question, and drops it the moment somebody answers', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue should retries land on?')

      const before = await inboxSection(fixture.maya.slaveId)
      expect(await inboxIds(fixture.maya.slaveId)).toEqual([asked])
      expect(before?.text).toContain('Which queue should retries land on?')

      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))

      expect(await inboxSection(fixture.maya.slaveId)).toBeNull()
    })

    // Fix round 1, finding 1: a human answer has to close the question too. The web route
    // (`apps/web/.../messages/[messageId]/answer`) is this verb behind an envelope -- before the
    // fix the panel resumed the asker and wrote nothing, so the question kept coming back into
    // every later run of every holder of the role, under a sentence that was by then false.
    it('drops the question for EVERY holder of the role once an operator answers it', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue should retries land on?')
      expect(await inboxIds(fixture.maya.slaveId)).toEqual([asked])
      expect(await inboxIds(fixture.nina.slaveId)).toEqual([asked])

      const written = await answerQuestion(asked, { body: 'payments-retry', answeredBy: 'web operator' })
      expect(written.ok).toBe(true)

      expect(await inboxIds(fixture.maya.slaveId)).toEqual([])
      expect(await inboxIds(fixture.nina.slaveId)).toEqual([])
    })

    it('never hands a slave its own question', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      expect(await inboxIds(fixture.alex.slaveId)).not.toContain(asked)
    })
  })

  describe('what the prompt teaches (final review, Important 2)', () => {
    it("an implementation run's prompt carries the ask envelope and the roster of who may be asked", async () => {
      const protocol = askProtocolSection()
      // The open tag itself, from the domain constant -- if the parser's marker ever moves, this
      // assertion moves with it and the prompt cannot silently teach a tag nothing reads.
      expect(protocol.text).toContain(ASK_BLOCK_OPEN)
      expect(protocol.text).toContain(ASK_BLOCK_CLOSE)
      // What the slave has to be told beyond the tag: that stopping here is free.
      expect(protocol.text).toContain('costs you no attempt')
      expect(protocol.text).toContain('answerer')

      // Who exists is its own section since M37 -- ordered above the protocol, which points at it.
      const roster = await rosterSection(fixture.alex.slaveId, fixture.workspaceId)
      expect(roster?.text).toContain('Maya')
      // And never itself: `recipientCanAnswer` refuses a slave that asks itself.
      expect(roster?.text).not.toContain(fixture.alex.slaveId)
    })

    it("a REVIEW run's prompt does not: a reviewer's ask is refused, so teaching it one would be a lie", () => {
      // Enforced by the run-kind order itself now, rather than by three prompt builders each
      // remembering not to include it. `runContext.test.ts` asserts a real review prompt carries
      // no `<slave-ask>`; this is the rule that makes that true.
      expect(SECTION_ORDER.review).not.toContain('ask_protocol')
      expect(SECTION_ORDER.planning).not.toContain('ask_protocol')
      expect(SECTION_ORDER.implementation).toContain('ask_protocol')
    })

    /**
     * M50 final wave, I2. "SLAVES YOU CAN ADDRESS" is a promise, and a released worker cannot keep
     * it: its engagement is over, its runtime roles are empty and it will never be dispatched
     * again, so a question addressed to it by id would leave the asker in `waiting` until
     * `waiting_stale` nudged a human. The row stays (R5) -- it is only no longer a mailbox.
     */
    it('leaves out a worker whose engagement is over: a released peer is not addressable', async () => {
      const before = await rosterSection(fixture.alex.slaveId, fixture.workspaceId)
      expect(before?.text).toContain('Maya')

      await prisma.slave.update({
        where: { id: fixture.maya.slaveId },
        data: { lifecycle: 'ephemeral', releasedAt: new Date(), releaseReason: 'the engagement is over', runtimeRoles: [] },
      })

      const after = await rosterSection(fixture.alex.slaveId, fixture.workspaceId)
      expect(after?.text).not.toContain('Maya')
      expect(after?.source.kind === 'roster' ? after.source.slaveIds : []).not.toContain(fixture.maya.slaveId)
    })

    it('offers nothing when there is nobody to ask: every recipient would be refused anyway', async () => {
      const alone = await prisma.workspace.create({
        data: { name: 'Solo', repoPath: '/tmp/solo', verifyCommands: ['true'], setupCommands: [] },
      })
      const team = await prisma.team.create({ data: { workspaceId: alone.id, name: 'Engineering' } })
      const only = await prisma.slave.create({ data: { teamId: team.id, name: 'Robin', role: 'backend', runtimeRoles: ['backend'] } })

      // No roster, and `buildRunContext` teaches the envelope only alongside one.
      expect(await rosterSection(only.id, alone.id)).toBeNull()
    })
  })

  describe('a question stops pending when its asker stops waiting (final review, Important 3)', () => {
    it('leaves no zombie in the recipient inbox after an operator resumes the asker by hand', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue should retries land on?')
      expect(await inboxIds(fixture.maya.slaveId)).toEqual([asked])
      const pendingBefore = await listPendingQuestions(fixture.workspaceId)
      expect(pendingBefore.ok && pendingBefore.value.map((row) => row.id)).toEqual([asked])

      // The operator's own way out -- `orchestrator resume --run <id>`, and the slave panel's
      // fallback Resume button. It resumes the run without ever answering the question.
      const requested = await requestResume(fixture.alex.runId, 'never mind, carry on', 'the operator')
      expect(requested.ok).toBe(true)
      const claim = await claimResume(fixture.alex.runId)
      expect(claim.claimed).toBe(true)

      // Nobody is waiting on it any more, so nobody is told they are holding somebody up. Before
      // the fix this question was re-injected into every subsequent run of every holder of the
      // role, forever, under a sentence that had stopped being true.
      expect(await inboxSection(fixture.maya.slaveId)).toBeNull()
      expect(await inboxSection(fixture.nina.slaveId)).toBeNull()
      const pendingAfter = await listPendingQuestions(fixture.workspaceId)
      expect(pendingAfter.ok && pendingAfter.value).toEqual([])

      // And it is not deleted -- the thread still reads as the conversation it was.
      expect(await prisma.slaveMessage.count({ where: { id: asked } })).toBe(1)
    })

    it('still pends while the asker is genuinely waiting', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      expect(await inboxIds(fixture.maya.slaveId)).toEqual([asked])
      const pending = await listPendingQuestions(fixture.workspaceId)
      expect(pending.ok && pending.value.map((row) => row.id)).toEqual([asked])
    })
  })

  describe('delivery', () => {
    it('resumes exactly the waiting run that asked, and no other', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await askAndWait(fixture, fixture.sam, 'How many retries?')
      await pumpEndingWith(
        fixture.maya,
        fixture.workspaceId,
        answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })),
      )

      const delivered = await deliverAnswers(fixture.workspaceId)

      expect(delivered).toEqual([{ runId: fixture.alex.runId, questionId: asked, answerId: expect.any(String) }])
      const alexRun = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.alex.runId } })
      expect(alexRun.resumeRequestedAt).not.toBeNull()
      expect(alexRun.queuedMessage).toContain('payments-retry')
      // The task is NOT flipped here: `claimResume` owns that write, atomically with the run's own.
      expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.alex.taskId } })).status).toBe('waiting')

      const samRun = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.sam.runId } })
      expect(samRun.resumeRequestedAt).toBeNull()
      expect(samRun.queuedMessage).toBeNull()
      expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.sam.taskId } })).status).toBe('waiting')
    })

    it('stamps the answer it used, so a debugger can see which one woke the run', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))

      await deliverAnswers(fixture.workspaceId)

      const row = await prisma.slaveMessage.findFirstOrThrow({ where: { kind: 'answer' } })
      expect(row.deliveredAt).not.toBeNull()
    })

    it('delivers nothing twice: a second pass over the same answer writes no second intent', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))

      expect(await deliverAnswers(fixture.workspaceId)).toHaveLength(1)
      expect(await deliverAnswers(fixture.workspaceId)).toEqual([])

      const requested = await prisma.executionEvent.count({
        where: { runId: fixture.alex.runId, type: 'run_resume_requested' },
      })
      expect(requested).toBe(1)
    })

    it('two answers delivered concurrently produce ONE resume', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      // Two answers to the same question: Maya's, and the operator's.
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))
      await answerQuestion(asked, { body: 'no -- payments-dlq', answeredBy: 'operator' })

      const [left, right] = await Promise.all([deliverAnswers(fixture.workspaceId), deliverAnswers(fixture.workspaceId)])

      // One of the two passes claimed the run; the other found nothing left to claim.
      expect(left.length + right.length).toBe(1)
      // And the answer that lost is stamped superseded, not left looking like one still pending.
      const answers = await prisma.slaveMessage.findMany({ where: { kind: 'answer' }, orderBy: { seq: 'asc' } })
      expect(answers.filter((row) => row.deliveredAt !== null)).toHaveLength(1)
      expect(answers.filter((row) => row.supersededAt !== null)).toHaveLength(1)
      expect(
        await prisma.executionEvent.count({ where: { runId: fixture.alex.runId, type: 'run_resume_requested' } }),
      ).toBe(1)

      // And the claim the tick makes is itself exactly-once: two processes reaching for the same
      // intent, one spawn between them.
      const claims = await Promise.all([claimResume(fixture.alex.runId), claimResume(fixture.alex.runId)])
      expect(claims.filter((claim) => claim.claimed)).toHaveLength(1)
      const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.alex.runId } })
      expect(run.status).toBe('resuming')
      // The claim path's own write, unchanged by delivery: the task comes back with the run.
      expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.alex.taskId } })).status).toBe('running')
    })

    it('stamps and logs the SECOND answer to a role-addressed question instead of dropping it', async () => {
      // The case the role broadcast makes ordinary: Maya and Nina both hold `answerer`, both were
      // shown the question, and both conclude with a real answer.
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))
      await pumpEndingWith(fixture.nina, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-dlq' })))

      const delivered = await deliverAnswers(fixture.workspaceId)

      expect(delivered).toHaveLength(1)
      const winner = await prisma.slaveMessage.findFirstOrThrow({ where: { slaveId: fixture.maya.slaveId, kind: 'answer' } })
      const loser = await prisma.slaveMessage.findFirstOrThrow({ where: { slaveId: fixture.nina.slaveId, kind: 'answer' } })
      expect(winner.deliveredAt).not.toBeNull()
      expect(winner.supersededAt).toBeNull()
      // The point of the fix: `null` no longer means both "pending" and "will never wake anybody".
      expect(loser.deliveredAt).toBeNull()
      expect(loser.supersededAt).not.toBeNull()
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.alex.runId } })).queuedMessage).toContain('payments-retry')
    })

    it('stamps an answer that arrives AFTER its rival was already delivered', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))
      await deliverAnswers(fixture.workspaceId)
      // Nina's run was already in flight with the question in its prompt; it concludes a tick later,
      // by which time the asker is no longer waiting and the loop above will never look at it.
      await pumpEndingWith(fixture.nina, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-dlq' })))

      expect(await deliverAnswers(fixture.workspaceId)).toEqual([])

      const loser = await prisma.slaveMessage.findFirstOrThrow({ where: { slaveId: fixture.nina.slaveId, kind: 'answer' } })
      expect(loser.supersededAt).not.toBeNull()
    })

    it('leaves an answer nobody has raced alone: pending is still pending', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))
      // Cancelled, so delivery refuses before the claim -- the answer is genuinely still pending.
      await prisma.task.update({ where: { id: fixture.alex.taskId }, data: { status: 'cancelled' } })

      await deliverAnswers(fixture.workspaceId)

      const row = await prisma.slaveMessage.findFirstOrThrow({ where: { kind: 'answer' } })
      expect(row.deliveredAt).toBeNull()
      expect(row.supersededAt).toBeNull()
    })

    it('does NOT resume a task the operator cancelled', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))
      await prisma.task.update({ where: { id: fixture.alex.taskId }, data: { status: 'cancelled' } })

      expect(await deliverAnswers(fixture.workspaceId)).toEqual([])
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.alex.runId } })).resumeRequestedAt).toBeNull()
    })

    it('does NOT resume a task that has been handed to another run', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))
      // Superseded: the task is somebody else's run now, whatever its status says.
      const successor = await prisma.slaveRun.create({
        data: { taskId: fixture.alex.taskId, slaveId: fixture.alex.slaveId, status: 'working' },
      })
      await prisma.task.update({
        where: { id: fixture.alex.taskId },
        data: { status: 'running', activeRunId: successor.id },
      })

      expect(await deliverAnswers(fixture.workspaceId)).toEqual([])
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.alex.runId } })).resumeRequestedAt).toBeNull()
    })

    it('does NOT resume a run the operator stopped', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))
      await prisma.slaveRun.update({
        where: { id: fixture.alex.runId },
        data: { stopRequestedBy: 'the operator', stopRequestedAt: new Date() },
      })

      expect(await deliverAnswers(fixture.workspaceId)).toEqual([])
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.alex.runId } })).resumeRequestedAt).toBeNull()
    })

    it("attributes the resume to whoever actually caused it: a slave's answer is not a human intervention", async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))

      await deliverAnswers(fixture.workspaceId)

      const requested = await prisma.executionEvent.findFirstOrThrow({
        where: { runId: fixture.alex.runId, type: 'run_resume_requested' },
      })
      expect(requested.actor).toBe('system')
      expect((requested.payload as { requestedBy?: string }).requestedBy).toBe('Maya (answerer)')
    })

    it('delivers an OPERATOR answer, so a human can unstick a project with no second worker', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      const written = await answerQuestion(asked, { body: 'payments-retry', answeredBy: 'operator' })
      expect(written.ok).toBe(true)

      const delivered = await deliverAnswers(fixture.workspaceId)

      expect(delivered).toHaveLength(1)
      const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.alex.runId } })
      expect(run.queuedMessage).toContain('payments-retry')
      expect(run.queuedMessage).toContain('the operator')
      // An operator's answer IS a human intervention, and is filed as one.
      const requested = await prisma.executionEvent.findFirstOrThrow({
        where: { runId: fixture.alex.runId, type: 'run_resume_requested' },
      })
      expect(requested.actor).toBe('human')
    })

    it('releases the answer it stamped when the resume is refused, and delivers it once the refusal clears', async () => {
      const asked = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await pumpEndingWith(fixture.maya, fixture.workspaceId, answer(JSON.stringify({ messageId: asked, answer: 'payments-retry' })))
      // A halted workspace is the honest refusal: `requestResume` refuses `workspace_halted`
      // before it records anything, and a halt is exactly the state an operator later clears.
      await prisma.workspace.update({
        where: { id: fixture.workspaceId },
        data: { haltedReason: 'a pause gate failed', haltedAt: new Date() },
      })

      expect(await deliverAnswers(fixture.workspaceId)).toEqual([])

      // Released, not left claimed: the stamp is back to null, so a later pass can try again.
      const held = await prisma.slaveMessage.findFirstOrThrow({ where: { kind: 'answer' } })
      expect(held.deliveredAt).toBeNull()
      expect(held.supersededAt).toBeNull()
      expect(
        await prisma.executionEvent.count({ where: { runId: fixture.alex.runId, type: 'run_resume_requested' } }),
      ).toBe(0)
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.alex.runId } })).resumeRequestedAt).toBeNull()

      // The operator clears the halt. The very same answer wakes the run, exactly once.
      await prisma.workspace.update({
        where: { id: fixture.workspaceId },
        data: { haltedReason: null, haltedAt: null },
      })

      const delivered = await deliverAnswers(fixture.workspaceId)
      expect(delivered).toEqual([{ runId: fixture.alex.runId, questionId: asked, answerId: held.id }])
      expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: held.id } })).deliveredAt).not.toBeNull()
      expect(await deliverAnswers(fixture.workspaceId)).toEqual([])
      expect(
        await prisma.executionEvent.count({ where: { runId: fixture.alex.runId, type: 'run_resume_requested' } }),
      ).toBe(1)
    })

    it('answers the LATEST question when a resumed run asked a second one', async () => {
      const first = await askAndWait(fixture, fixture.alex, 'Which queue?')
      await answerQuestion(first, { body: 'payments-retry', answeredBy: 'operator' })
      await deliverAnswers(fixture.workspaceId)
      // What the tick does next: claim, spawn, and the resumed run asks again.
      await claimResume(fixture.alex.runId)
      const second = await askAndWait(fixture, fixture.alex, 'How many retries?')
      expect(second).not.toBe(first)

      // The first question's answer is already delivered; only the second one can wake it now.
      expect(await deliverAnswers(fixture.workspaceId)).toEqual([])
      await answerQuestion(second, { body: 'three', answeredBy: 'operator' })
      const delivered = await deliverAnswers(fixture.workspaceId)

      expect(delivered).toEqual([{ runId: fixture.alex.runId, questionId: second, answerId: expect.any(String) }])
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.alex.runId } })).queuedMessage).toContain('three')
    })
  })
})
