import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { CHAT_MESSAGE_MAX_CHARS, type ChatAttachment } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recentFeed } from '../../src/feed.js'
import { refusalText } from '../../src/refusal.js'
import type { DeciderRegistry, ModelDecider } from '../../src/simulation/llm.js'
import { listDecisions, recordDecision } from '../../src/supervisor.js'
import {
  NO_DECIDER_REASON,
  drainSupervisorChatCalls,
  inFlightSupervisorChat,
  tickSupervisorChat,
} from '../../src/supervisorChatTick.js'
import {
  SUPERVISOR_CHAT_CLAIM_TTL_MS,
  claimSupervisorTurns,
  conversationCost,
  listSupervisorMessages,
  recordSupervisorReply,
  sendSupervisorMessage,
} from '../../src/supervisorChat.js'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskId: string
}

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorMessage", "SupervisorDecision", "SlaveMessage", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
  )
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout-chat', verifyCommands: ['npm test'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: 'Maya' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, role: 'Senior Engineer', runtimeRoles: ['backend'], personId: person.id },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Checkout form',
      description: 'make it work',
      status: 'blocked',
      requiredRole: 'backend',
      attempt: 1,
      maxAttempts: 3,
      branch: 'slaveofai/T-abcd1234-checkout-form',
    },
  })
  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id }
}

describe('recentFeed', () => {
  let f: Fixture

  beforeEach(async (): Promise<void> => {
    await reset()
    f = await seed()
  })

  it('says what happened in sentences, oldest first, with the log seq a citation names', async (): Promise<void> => {
    const created = await appendEvent({
      type: 'task.created',
      workspaceId: f.workspaceId,
      taskId: f.taskId,
      actor: 'system',
      payload: { title: 'Checkout form', requiredRole: 'backend' },
    })
    const started = await appendEvent({
      type: 'run.started',
      workspaceId: f.workspaceId,
      taskId: f.taskId,
      slaveId: f.slaveId,
      actor: 'system',
      payload: { sessionId: 's-1' },
    })

    const feed = await recentFeed(f.workspaceId, 20)
    expect(feed).toEqual([
      { seq: Number(created.seq), sentence: '"Checkout form" was added to the board' },
      { seq: Number(started.seq), sentence: 'Maya started "Checkout form"' },
    ])
  })

  it('keeps the NEWEST when the limit bites, and reads nothing from another project', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other-chat', verifyCommands: ['npm test'], setupCommands: [] },
    })
    await appendEvent({ type: 'task.created', workspaceId: other.id, actor: 'system', payload: { title: 'Elsewhere', requiredRole: null } })
    for (const title of ['one', 'two', 'three']) {
      await appendEvent({ type: 'task.created', workspaceId: f.workspaceId, actor: 'system', payload: { title, requiredRole: null } })
    }

    const feed = await recentFeed(f.workspaceId, 2)
    expect(feed).toHaveLength(2)
    expect(feed.map((line) => line.sentence)).toEqual(['a task was added to the board', 'a task was added to the board'])
    // Ascending by the log's own seq, which is what the prompt prints and a citation looks up.
    expect(feed[0]!.seq).toBeLessThan(feed[1]!.seq)
  })

  it('ignores the event families the feed does not speak for, and a limit of nothing', async (): Promise<void> => {
    await appendEvent({
      type: 'run.output',
      workspaceId: f.workspaceId,
      slaveId: f.slaveId,
      actor: 'slave',
      payload: { text: 'chatter' },
    })
    expect(await recentFeed(f.workspaceId, 20)).toEqual([])
    expect(await recentFeed(f.workspaceId, 0)).toEqual([])
  })
})

describe('sendSupervisorMessage', () => {
  let f: Fixture

  beforeEach(async (): Promise<void> => {
    await reset()
    f = await seed()
  })

  it('writes the person’s line and the reply placeholder in one go', async (): Promise<void> => {
    const sent = await sendSupervisorMessage(f.workspaceId, { text: '  why is nothing running?  ' })
    if (!sent.ok) throw new Error(refusalText(sent.error))

    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: sent.value.messageId,
      seq: 0,
      role: 'human',
      status: 'sent',
      text: 'why is nothing running?',
      attachments: [],
      actions: null,
    })
    // The placeholder is what the panel draws as "thinking", and it carries no invented sentence.
    expect(rows[1]).toMatchObject({ id: sent.value.replyId, seq: 1, role: 'supervisor', status: 'answering', text: '' })
  })

  it('keeps the attachments it was handed, and numbers the next exchange after them', async (): Promise<void> => {
    const attachment = { path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 7, kind: 'text' as const }
    const first = await sendSupervisorMessage(f.workspaceId, { text: 'read this', attachments: [attachment] })
    expect(first.ok).toBe(true)
    const second = await sendSupervisorMessage(f.workspaceId, { text: 'and this' })
    expect(second.ok).toBe(true)

    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
    expect(rows[0]?.attachments).toEqual([attachment])
  })

  it('refuses a blank message, one past the cap, and an unknown project', async (): Promise<void> => {
    const blank = await sendSupervisorMessage(f.workspaceId, { text: '   ' })
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.error.kind).toBe('invalid_message')

    const long = await sendSupervisorMessage(f.workspaceId, { text: 'x'.repeat(CHAT_MESSAGE_MAX_CHARS + 1) })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.error.kind).toBe('invalid_message')

    expect(await sendSupervisorMessage('nope', { text: 'hello' })).toEqual({
      ok: false,
      error: { kind: 'workspace_not_found', workspaceId: 'nope' },
    })
    expect(await listSupervisorMessages(f.workspaceId)).toEqual([])
  })

  it('refuses an attachment that is not a file in the inbox', async (): Promise<void> => {
    const outside = await sendSupervisorMessage(f.workspaceId, {
      text: 'read this',
      attachments: [{ path: 'src/secrets.md', name: 'secrets.md', bytes: 1, kind: 'text' }],
    })
    expect(outside.ok).toBe(false)
    if (!outside.ok) expect(outside.error.kind).toBe('attachment_path_refused')
    expect(await listSupervisorMessages(f.workspaceId)).toEqual([])
  })
})

describe('claimSupervisorTurns and recordSupervisorReply', () => {
  let f: Fixture

  beforeEach(async (): Promise<void> => {
    await reset()
    f = await seed()
  })

  const say = async (text: string): Promise<{ messageId: string; replyId: string }> => {
    const sent = await sendSupervisorMessage(f.workspaceId, { text })
    if (!sent.ok) throw new Error(refusalText(sent.error))
    return sent.value
  }

  it('hands over the placeholder with the message, the settings and the history', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: f.workspaceId },
      data: { supervisorProvider: 'cursor', supervisorModel: 'grok-4' },
    })
    const first = await say('what is the plan?')
    await recordSupervisorReply(first.replyId, {
      kind: 'answered',
      text: 'three tasks are on the board',
      actions: [],
      costUsd: 0.02,
      unmeasured: false,
    })
    const second = await say('and the second one?')

    const claimed = await claimSupervisorTurns({ by: 'test', limit: 5 })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({
      id: second.replyId,
      workspaceId: f.workspaceId,
      message: 'and the second one?',
      provider: 'cursor',
      model: 'grok-4',
    })
    expect(claimed[0]?.history).toEqual([
      { role: 'human', text: 'what is the plan?' },
      { role: 'supervisor', text: 'three tasks are on the board' },
    ])
  })

  it('claims a turn once, and again only after the claim has gone stale', async (): Promise<void> => {
    await say('hello?')
    const now = new Date()
    expect(await claimSupervisorTurns({ by: 'one', limit: 5, now })).toHaveLength(1)
    expect(await claimSupervisorTurns({ by: 'two', limit: 5, now })).toHaveLength(0)

    const later = new Date(now.getTime() + SUPERVISOR_CHAT_CLAIM_TTL_MS + 1000)
    const reclaimed = await claimSupervisorTurns({ by: 'two', limit: 5, now: later })
    expect(reclaimed).toHaveLength(1)
    const row = await prisma.supervisorMessage.findUniqueOrThrow({ where: { id: reclaimed[0]!.id } })
    expect(row.claimedBy).toBe('two')
  })

  it('records an answer with its actions, its cost and the released claim', async (): Promise<void> => {
    const { replyId } = await say('add a pricing page')
    await claimSupervisorTurns({ by: 'test', limit: 5 })
    const action = { kind: 'request_goal_change' as const, request: 'Add a pricing page' }

    expect(
      await recordSupervisorReply(replyId, {
        kind: 'answered',
        text: 'I have asked for the goal to change.',
        actions: [{ action, decisionId: 'd-1', tier: 'proposed' }],
        costUsd: 0.04,
        unmeasured: false,
      }),
    ).toEqual({ ok: true, value: undefined })

    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows[1]).toMatchObject({
      status: 'answered',
      text: 'I have asked for the goal to change.',
      modelCostUsd: 0.04,
      unmeasured: false,
      actions: [{ action, decisionId: 'd-1', tier: 'proposed' }],
    })
    const row = await prisma.supervisorMessage.findUniqueOrThrow({ where: { id: replyId } })
    expect(row.claimedAt).toBeNull()
    expect(row.claimedBy).toBeNull()
  })

  it('records a failure with its reason, and charges an unmeasured call honestly', async (): Promise<void> => {
    const { replyId } = await say('are you there?')
    expect(
      await recordSupervisorReply(replyId, {
        kind: 'failed',
        reason: 'the model could not be reached',
        costUsd: null,
        unmeasured: true,
      }),
    ).toEqual({ ok: true, value: undefined })

    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows[1]).toMatchObject({
      status: 'failed',
      failureReason: 'the model could not be reached',
      modelCostUsd: null,
      unmeasured: true,
    })
  })

  it('refuses to record a second reply for a turn that has already settled', async (): Promise<void> => {
    const { replyId } = await say('hello')
    await recordSupervisorReply(replyId, { kind: 'answered', text: 'first', actions: [], costUsd: 0.01, unmeasured: false })

    const again = await recordSupervisorReply(replyId, {
      kind: 'answered',
      text: 'second',
      actions: [],
      costUsd: 0.01,
      unmeasured: false,
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.kind).toBe('message_not_answering')
    expect((await listSupervisorMessages(f.workspaceId))[1]?.text).toBe('first')
  })

  it('adds the conversation up, counting what nobody could price rather than calling it zero', async (): Promise<void> => {
    const one = await say('first')
    await recordSupervisorReply(one.replyId, { kind: 'answered', text: 'a', actions: [], costUsd: 0.25, unmeasured: false })
    const two = await say('second')
    await recordSupervisorReply(two.replyId, { kind: 'answered', text: 'b', actions: [], costUsd: null, unmeasured: true })

    expect(await conversationCost(f.workspaceId)).toEqual({ usd: 0.25, unmeasuredTurns: 1 })
  })
})

/** One scripted decider and the calls it was handed, the `tickIntakes` test's own shape: the tick
 *  knows nothing about how a call is made, so a test's `async () => …` IS the provider. */
interface Scripted extends ModelDecider {
  readonly calls: { model: string; prompt: string; tools?: string; cwd?: string; permissionsFilePath?: string; runToken?: string }[]
}

const answering = (reply: unknown, costUsd: number | null = 0.03): Scripted => {
  const calls: Scripted['calls'] = []
  const decider: ModelDecider = async (input) => {
    calls.push({
      model: input.model,
      prompt: input.prompt,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.permissionsFilePath === undefined ? {} : { permissionsFilePath: input.permissionsFilePath }),
      ...(input.runToken === undefined ? {} : { runToken: input.runToken }),
    })
    return {
      kind: 'answer',
      text: typeof reply === 'string' ? reply : JSON.stringify({ supervisorReply: reply }),
      costUsd,
      tokens: null,
      numTurns: 1,
    }
  }
  return Object.assign(decider, { calls })
}

const failing = (reason: string): ModelDecider => async () => ({ kind: 'failed', reason, costUsd: null, tokens: null })

const registryOf = (claudeCode: ModelDecider, cursor: ModelDecider = failing('no cursor here')): DeciderRegistry => ({
  claude_code: claudeCode,
  cursor,
})

describe('tickSupervisorChat', () => {
  let f: Fixture
  let repoPath: string

  beforeEach(async (): Promise<void> => {
    await reset()
    f = await seed()
    repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-chat-tick-'))
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { repoPath } })
  })

  afterEach(async (): Promise<void> => {
    await drainSupervisorChatCalls()
    rmSync(repoPath, { recursive: true, force: true })
  })

  const say = async (text: string, attachments: readonly ChatAttachment[] = []): Promise<string> => {
    const sent = await sendSupervisorMessage(f.workspaceId, { text, attachments })
    if (!sent.ok) throw new Error(refusalText(sent.error))
    return sent.value.replyId
  }

  const run = async (deciders: DeciderRegistry, defaultModel = 'claude-sonnet-5'): Promise<void> => {
    await tickSupervisorChat({ now: new Date(), by: 'test', deciders, defaultModel })
    await drainSupervisorChatCalls()
  }

  it('answers a waiting turn end to end, with the default model and the per-call cap', async (): Promise<void> => {
    await appendEvent({
      type: 'task.created',
      workspaceId: f.workspaceId,
      taskId: f.taskId,
      actor: 'system',
      payload: { title: 'Checkout form', requiredRole: 'backend' },
    })
    const replyId = await say('why is nothing running?')
    const decider = answering({ text: 'Nothing is dispatched: the one task is blocked.', actions: [], sources: [] })

    const report = await tickSupervisorChat({
      now: new Date(),
      by: 'test',
      deciders: registryOf(decider),
      defaultModel: 'claude-sonnet-5',
    })
    expect(report).toMatchObject({ due: 1, startedModelCalls: 1 })
    await drainSupervisorChatCalls()

    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows[1]).toMatchObject({
      id: replyId,
      status: 'answered',
      text: 'Nothing is dispatched: the one task is blocked.',
      modelCostUsd: 0.03,
      unmeasured: false,
    })
    // The prompt carries the conversation, the board and the feed this turn rendered.
    expect(decider.calls[0]?.model).toBe('claude-sonnet-5')
    expect(decider.calls[0]?.prompt).toContain('why is nothing running?')
    expect(decider.calls[0]?.prompt).toContain('"Checkout form" was added to the board')
    expect(decider.calls[0]?.prompt).toContain('Checkout form')
    // Text-only: no tools, no repository, nothing armed.
    expect(decider.calls[0]?.tools).toBeUndefined()
    expect(inFlightSupervisorChat().size).toBe(0)
  })

  it('asks the runtime the PROJECT chose, with the model it pinned', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: f.workspaceId },
      data: { supervisorProvider: 'cursor', supervisorModel: 'grok-4' },
    })
    await say('who is on this?')
    const claude = answering({ text: 'from claude', actions: [], sources: [] })
    const cursor = answering({ text: 'from cursor', actions: [], sources: [] })

    await run(registryOf(claude, cursor))

    expect(claude.calls).toHaveLength(0)
    expect(cursor.calls).toHaveLength(1)
    expect(cursor.calls[0]?.model).toBe('grok-4')
    expect((await listSupervisorMessages(f.workspaceId))[1]?.text).toBe('from cursor')
  })

  it('fails the ONE turn whose provider this daemon has no decider for', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { supervisorProvider: 'cursor' } })
    await say('anyone there?')

    // A registry missing an entry is a shape `DeciderRegistry` forbids, which is the point: this is
    // the runtime hole (a column a future version wrote), reached by a cast.
    await run({ claude_code: answering({ text: 'hi', actions: [], sources: [] }) } as unknown as DeciderRegistry)

    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows[1]).toMatchObject({ status: 'failed', failureReason: NO_DECIDER_REASON })
  })

  it('records a reply that could not be read as a failure, and charges what the call cost', async (): Promise<void> => {
    await say('hello?')
    await run(registryOf(answering('I am not JSON at all', 0.01)))

    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows[1]).toMatchObject({ status: 'failed', failureReason: 'the reply could not be read', modelCostUsd: 0.01 })
  })

  it('records an unreachable model as a failure charged as unmeasured', async (): Promise<void> => {
    await say('hello?')
    await run(registryOf(failing('the CLI exited 1')))

    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows[1]).toMatchObject({ status: 'failed', failureReason: 'the CLI exited 1', unmeasured: true })
  })

  it('turns two asked-for actions into two decisions, PROPOSED under propose', async (): Promise<void> => {
    const replyId = await say('add a pricing page, and tell the planner about the brief')
    await run(
      registryOf(
        answering({
          text: 'Asked for both.',
          actions: [
            { kind: 'request_goal_change', request: 'Add a pricing page' },
            { kind: 'note_for_planner', text: 'the brief is in docs/inbox' },
          ],
          sources: [],
        }),
      ),
    )

    const decisions = await listDecisions(f.workspaceId)
    expect(decisions).toHaveLength(2)
    expect(decisions.every((decision) => decision.situationKind === 'operator_request')).toBe(true)
    expect(decisions.every((decision) => decision.status === 'pending' && decision.tier === 'proposed')).toBe(true)
    // Every situation carries the message it came from, whatever the key it is cooled on.
    expect(decisions.every((decision) => decision.situation.facts['messageId'] === replyId)).toBe(true)
    // Nothing was carried out: the goal is untouched and nothing was committed.
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).goalVersion).toBe(0)

    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows[1]?.actions?.map((entry) => [entry.action.kind, entry.tier])).toEqual([
      ['request_goal_change', 'proposed'],
      ['note_for_planner', 'proposed'],
    ])
  })

  it('carries the same action out at once under act', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { supervisorAutonomy: 'act' } })
    await say('add a pricing page')
    await run(
      registryOf(
        answering({
          text: 'Done.',
          actions: [{ kind: 'request_goal_change', request: 'Add a pricing page' }],
          sources: [],
        }),
      ),
    )

    const decisions = await listDecisions(f.workspaceId)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ tier: 'applied', status: 'applied' })
    const versions = await prisma.goalVersion.findMany({ where: { workspaceId: f.workspaceId } })
    expect(versions).toHaveLength(1)
    expect(versions[0]?.request).toBe('Add a pricing page')
    expect((await listSupervisorMessages(f.workspaceId))[1]?.actions?.[0]?.tier).toBe('applied')
  })

  it('appends the sentence for an action that named a row the board does not hold', async (): Promise<void> => {
    await say('cancel task t-99')
    await run(
      registryOf(
        answering({
          text: 'I cannot find that task.',
          actions: [{ kind: 'cancel_task', taskId: 't-99', reason: 'they asked' }],
          sources: [],
        }),
      ),
    )

    expect(await listDecisions(f.workspaceId)).toHaveLength(0)
    const rows = await listSupervisorMessages(f.workspaceId)
    expect(rows[1]?.text).toContain('I cannot find that task.')
    expect(rows[1]?.text).toContain('an action named a task that is not on the board: t-99')
  })

  it('arms a read-only turn for an image on claude_code, granting read_repo and nothing else', async (): Promise<void> => {
    mkdirSync(join(repoPath, 'docs', 'inbox'), { recursive: true })
    writeFileSync(join(repoPath, 'docs/inbox/2026-09-20-shot.png'), 'not really a png')
    await say('what is wrong with this screen?', [
      { path: 'docs/inbox/2026-09-20-shot.png', name: 'shot.png', bytes: 16, kind: 'image' },
    ])
    const decider = answering({ text: 'The header is cut off.', actions: [], sources: [] })

    await run(registryOf(decider))

    const call = decider.calls[0]
    expect(call?.tools).toBe('read-only')
    expect(call?.cwd).toBe(repoPath)
    expect(call?.runToken).toMatch(/^[0-9a-f]{64}$/)
    expect(call?.prompt).toContain('You may open an image with Read.')

    const verdict = JSON.parse(readFileSync(call!.permissionsFilePath!, 'utf8')) as {
      grants: string[]
      allow: { kind: string }[]
      runId: string
      tokenHash: string
    }
    expect(verdict.grants).toEqual(['read_repo'])
    expect([...new Set(verdict.allow.map((entry) => entry.kind))]).toEqual(['read_repo'])
    expect(verdict.tokenHash).toBe(createHash('sha256').update(call!.runToken!, 'utf8').digest('hex'))
  })

  it('never arms tools for a cursor turn, and never offers to open the image', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { supervisorProvider: 'cursor' } })
    await say('what is wrong with this screen?', [
      { path: 'docs/inbox/2026-09-20-shot.png', name: 'shot.png', bytes: 16, kind: 'image' },
    ])
    const cursor = answering({ text: 'I cannot see pictures.', actions: [], sources: [] })

    await run(registryOf(failing('unused'), cursor))

    expect(cursor.calls[0]?.tools).toBeUndefined()
    expect(cursor.calls[0]?.permissionsFilePath).toBeUndefined()
    expect(cursor.calls[0]?.prompt).not.toContain('You may open an image with Read.')
  })

  it('inlines a text attachment the person handed over, capped', async (): Promise<void> => {
    mkdirSync(join(repoPath, 'docs', 'inbox'), { recursive: true })
    writeFileSync(join(repoPath, 'docs/inbox/2026-09-20-brief.md'), 'Ship the pricing page by Friday.')
    await say('read the brief', [
      { path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 31, kind: 'text' },
    ])
    const decider = answering({ text: 'Read it.', actions: [], sources: [] })

    await run(registryOf(decider))

    expect(decider.calls[0]?.prompt).toContain('Ship the pricing page by Friday.')
    expect(decider.calls[0]?.tools).toBeUndefined()
  })

  it('starts no second call for a turn whose first is still out, and drains what it started', async (): Promise<void> => {
    await say('take your time')
    // Two deferreds rather than one: the call is DETACHED, so the test has to wait until the
    // decider has really been entered before it can say anything about what is in flight.
    let entered = (): void => undefined
    let release = (): void => undefined
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: ModelDecider = async () => {
      entered()
      await held
      return { kind: 'answer', text: JSON.stringify({ supervisorReply: { text: 'done', actions: [], sources: [] } }), costUsd: 0.01, tokens: null, numTurns: 1 }
    }

    const first = await tickSupervisorChat({ now: new Date(), by: 'test', deciders: registryOf(slow), defaultModel: 'm' })
    expect(first.startedModelCalls).toBe(1)
    await reached
    expect(inFlightSupervisorChat().size).toBe(1)

    // The claim alone keeps the second pass off the row, and the in-flight set keeps this process
    // from paying twice even when a TTL reclaim races it.
    const second = await tickSupervisorChat({ now: new Date(), by: 'test', deciders: registryOf(slow), defaultModel: 'm' })
    expect(second).toMatchObject({ startedModelCalls: 0, skippedInFlight: 1 })

    release()
    await drainSupervisorChatCalls()
    expect(inFlightSupervisorChat().size).toBe(0)
    expect((await listSupervisorMessages(f.workspaceId))[1]?.status).toBe('answered')
  })

  it('shows the model what is waiting on a person', async (): Promise<void> => {
    await recordDecision({
      workspaceId: f.workspaceId,
      situation: {
        kind: 'review_cap_blocked',
        subjectId: f.taskId,
        summary: 'the task is parked at the review cap',
        facts: { taskId: f.taskId },
      },
      candidates: [{ action: { kind: 'cancel_task', taskId: f.taskId, reason: 'stuck' }, tier: 'proposed', why: 'rules' }],
      chosenIndex: 0,
      rationale: 'parked',
      decidedBy: 'rules',
      modelCostUsd: null,
    })
    await say('what needs me?')
    const decider = answering({ text: 'One decision is waiting.', actions: [], sources: [] })

    await run(registryOf(decider))

    expect(decider.calls[0]?.prompt).toContain('the task is parked at the review cap')
  })
})
