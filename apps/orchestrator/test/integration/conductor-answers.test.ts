/**
 * Supervisor-as-conductor plan B, Task 6 (spec C4): the Supervisor's pass answers a goal version's
 * conductor questions in ONE batched call, outside the per-tick cap, paused askers first; a failed
 * batch writes no decision and is retried, and after three a person gets the question with the
 * reason; the critical lexicon, a missing model and a missing plan all hand the question to a person
 * by the rules.
 */
import { rejectDecision, reportQuestionKey, sendMessage, type ModelDecider, type ModelOutcome } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE, COOLDOWN_MS, WAITING_STALE_MS } from '@slave-of-ai/domain'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deliverAnswers } from '../../src/deliver.js'
import { buildRunContext } from '../../src/runContext.js'
import { supervise } from '../../src/supervisor.js'

const answerJson = (entries: object[]): ModelOutcome => ({ kind: 'answer', text: JSON.stringify({ conductorAnswers: entries }), costUsd: 0.05, tokens: null, numTurns: 1 })
const idsIn = (prompt: string): string[] => [...prompt.matchAll(/^QUESTION (\S+) /gmu)].map((m) => m[1] ?? '')

function scripted(reply: (prompt: string) => ModelOutcome): { readonly decider: ModelDecider; readonly prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    decider: async (input) => {
      prompts.push(input.prompt)
      return reply(input.prompt)
    },
  }
}

const ok = (messageId: string, over: object = {}): object => ({
  messageId,
  answer: 'Yes: camelCase, as the shared decision says.',
  basis: { requirements: ['R1'], packages: ['report'], decisions: [] },
  changes: 'none',
  newDecision: null,
  handOff: null,
  ...over,
})

interface Fixture {
  readonly workspaceId: string
  readonly seatId: string
  readonly integrationTaskId: string
  readonly qReport: string
  readonly qPaused: string
  readonly now: Date
}

let seeded = 0

/**
 * A conducted version mid-integration: `report` (R1, R2) finished and asked in its report;
 * `integration` is parked on an ask to the conductor.
 */
async function seed(opts: { readonly reportQuestion?: string; readonly extraReportQuestions?: number } = {}): Promise<Fixture> {
  seeded += 1
  const workspace = await prisma.workspace.create({
    data: { name: `Conductor batch ${String(seeded)}`, repoPath: '/nonexistent', baseBranch: 'main', verifyCommands: [], setupCommands: [], delivery: 'conducted' },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: `Ivo ${String(seeded)}` } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Implementer', runtimeRoles: ['implementer'], personId: person.id } })
  await prisma.requirementSet.create({
    data: {
      workspaceId: workspace.id,
      goalVersion: 1,
      items: [
        { key: 'R1', text: 'The report endpoints return JSON.', source: 'goal' },
        { key: 'R2', text: 'The API is versioned.', source: 'goal' },
      ],
    },
  })
  await prisma.goalDelivery.create({ data: { workspaceId: workspace.id, goalVersion: 1, status: 'integrating', integrationBranch: 'slaveofai/goal-v1-x', baseCommit: 'a'.repeat(40) } })
  const plan = [
    { key: 'report', requirementKeys: ['R1', 'R2'], ownedPaths: ['src/report/**'], isIntegration: false, status: 'done' as const },
    { key: 'integration', requirementKeys: [], ownedPaths: ['scripts/verify.d/integration.sh'], isIntegration: true, status: 'waiting' as const },
  ]
  const taskOf: Record<string, string> = {}
  for (const p of plan) {
    const pkg = await prisma.workPackage.create({
      data: { workspaceId: workspace.id, goalVersion: 1, key: p.key, title: p.key, requirementKeys: p.requirementKeys, ownedPaths: p.ownedPaths, interface: '', isIntegration: p.isIntegration, templateId: 'tpl' },
    })
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: p.key,
        description: 'x',
        status: p.status,
        requiredRole: 'implementer',
        maxAttempts: 3,
        goalVersion: 1,
        workPackageId: pkg.id,
        assigneeId: seat.id,
        integratedAt: p.status === 'done' ? new Date() : null,
      },
    })
    taskOf[p.key] = task.id
  }
  const reportTaskId = taskOf['report'] ?? ''
  const integrationTaskId = taskOf['integration'] ?? ''

  const reportRun = await prisma.slaveRun.create({ data: { taskId: reportTaskId, slaveId: seat.id, status: 'succeeded', terminalAt: new Date() } })
  const ask = async (runId: string, taskId: string, body: string, idempotencyKey?: string): Promise<string> => {
    const sent = await sendMessage(runId, {
      kind: 'question',
      body,
      recipientRole: CONDUCTOR_ROLE,
      expectsReply: true,
      taskId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })
    if (!sent.ok) throw new Error(`send failed: ${JSON.stringify(sent.error)}`)
    return sent.value.id
  }
  const qReport = await ask(reportRun.id, reportTaskId, opts.reportQuestion ?? 'Is JSON camelCase?', reportQuestionKey(reportRun.id, 0))
  for (let i = 0; i < (opts.extraReportQuestions ?? 0); i += 1) {
    await ask(reportRun.id, reportTaskId, `Is report field ${String(i)} optional?`, reportQuestionKey(reportRun.id, i + 1))
  }

  const parked = await prisma.slaveRun.create({ data: { taskId: integrationTaskId, slaveId: seat.id, status: 'paused', pauseReason: 'waiting_for_answer' } })
  await prisma.task.update({ where: { id: integrationTaskId }, data: { activeRunId: parked.id } })
  // A parked run holds its checkpoint; the delivery pass resumes from it.
  await prisma.checkpoint.create({
    data: {
      runId: parked.id,
      sessionId: 's-1',
      worktreePath: '/nonexistent/wt',
      pauseFlagPath: '/nonexistent/wt/pause.flag',
      settingsPath: '/nonexistent/wt/settings.json',
      hookPath: '/nonexistent/wt/pause-gate.sh',
      gitAuthorName: 'Ivo',
      gitAuthorEmail: 'ivo@slaveofai.local',
      headCommit: 'abc123',
    },
  })
  const qPaused = await ask(parked.id, integrationTaskId, 'Which port does the API listen on?')

  return { workspaceId: workspace.id, seatId: seat.id, integrationTaskId, qReport, qPaused, now: new Date(Date.now() + 60_000) }
}

/** Another conducted version with one finished package whose run asked one report question. */
async function addVersion(f: Fixture, goalVersion: number): Promise<string> {
  const pkg = await prisma.workPackage.create({
    data: { workspaceId: f.workspaceId, goalVersion, key: 'report', title: 'report', requirementKeys: [], ownedPaths: ['src/report/**'], interface: '', isIntegration: false, templateId: 'tpl' },
  })
  const task = await prisma.task.create({
    data: { workspaceId: f.workspaceId, title: `report v${String(goalVersion)}`, description: 'x', status: 'done', requiredRole: 'implementer', maxAttempts: 3, goalVersion, workPackageId: pkg.id, assigneeId: f.seatId, integratedAt: new Date() },
  })
  const run = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: f.seatId, status: 'succeeded', terminalAt: new Date() } })
  const sent = await sendMessage(run.id, { kind: 'question', body: `Is v${String(goalVersion)} JSON camelCase?`, recipientRole: CONDUCTOR_ROLE, expectsReply: true, taskId: task.id, idempotencyKey: reportQuestionKey(run.id, 0) })
  if (!sent.ok) throw new Error(`send failed: ${JSON.stringify(sent.error)}`)
  return sent.value.id
}

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "ConductorCall", "GoalDecision", "PackageHandOff", "SlaveMessage", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'

afterAll(async () => {
  await prisma.$disconnect()
})

describe('answerConductorQuestions (spec C4)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('answers every conductor question of the version in one call, paused first; resumes the paused run; charges the call once', async () => {
    const f = await seed()
    const model = scripted((prompt) =>
      answerJson(idsIn(prompt).map((id) => ok(id, id === f.qPaused ? { newDecision: { title: 'API port', decision: '8080 unless PORT is set' } } : {}))),
    )
    const report = await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => f.now })
    expect(model.prompts).toHaveLength(1)
    expect(idsIn(model.prompts[0] ?? '')).toEqual([f.qPaused, f.qReport])
    expect(report).toMatchObject({ conductorCalls: 1, modelCalls: 0, answered: 2, applied: 2 })
    const decisions = await prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, situationKind: 'conductor_question' } })
    expect(decisions.map((d) => [d.subjectId, d.tier, d.modelCalled, d.modelCostUsd])).toEqual(
      expect.arrayContaining([
        [f.qPaused, 'applied', false, null],
        [f.qReport, 'applied', false, null],
      ]),
    )
    const call = await prisma.conductorCall.findFirstOrThrow({ where: { workspaceId: f.workspaceId, stage: 'answer' } })
    expect(call).toMatchObject({ outcome: 'ok', modelCostUsd: 0.05, goalVersion: 1 })
    expect([...call.questionIds].sort()).toEqual([f.qPaused, f.qReport].sort())
    expect(await prisma.goalDecision.findMany({ select: { title: true, source: true } })).toEqual([{ title: 'API port', source: 'conductor_answer' }])
    await deliverAnswers(f.workspaceId)
    const delivered = await prisma.slaveMessage.findFirstOrThrow({ where: { replyToId: f.qPaused, kind: 'answer' } })
    expect(delivered.deliveredAt).not.toBeNull()
  })

  it('sends an answer that would move ownership to a person, and one with an unverifiable basis for approval', async () => {
    const f = await seed()
    const model = scripted((prompt) =>
      answerJson(idsIn(prompt).map((id) => (id === f.qReport ? ok(id, { changes: 'ownership' }) : ok(id, { basis: { requirements: ['R99'], packages: [], decisions: [] } })))),
    )
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => f.now })
    const byId = new Map((await prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId } })).map((d) => [d.subjectId, d]))
    expect(byId.get(f.qReport)).toMatchObject({ tier: 'escalated', status: 'pending' })
    expect(byId.get(f.qPaused)).toMatchObject({ tier: 'proposed', status: 'pending' })
    expect(await prisma.slaveMessage.count({ where: { workspaceId: f.workspaceId, kind: 'answer' } })).toBe(0)
  })

  it("does not bring back a finished task's question a person rejected, after the cooldown (spec C5, OBS-9)", async () => {
    const f = await seed()
    const model = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id, { changes: 'ownership' }))))
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => f.now })
    const pending = await prisma.supervisorDecision.findFirstOrThrow({ where: { subjectId: f.qReport } })
    expect((await rejectDecision(pending.id)).ok).toBe(true)
    const later = new Date(f.now.getTime() + COOLDOWN_MS + 60_000)
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => later })
    expect(await prisma.supervisorDecision.count({ where: { subjectId: f.qReport } })).toBe(1)
    // qPaused's escalation is still open (a person has not looked), so nothing is asked at all.
    expect(model.prompts).toHaveLength(1)
  })

  it('writes no decision for a failed batch, and gives the question to a person with the reason after three (spec C4)', async () => {
    const f = await seed()
    const model = scripted(() => ({ kind: 'failed', reason: 'model overloaded', costUsd: null, tokens: null }))
    for (let i = 0; i < 3; i += 1) await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => new Date(f.now.getTime() + i * 1000) })
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: 'conductor_question' } })).toBe(0)
    expect(await prisma.conductorCall.count({ where: { workspaceId: f.workspaceId, stage: 'answer', outcome: 'failed', unmeasured: true } })).toBe(3)
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => new Date(f.now.getTime() + 5000) })
    expect(model.prompts).toHaveLength(3)
    const escalated = await prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, situationKind: 'conductor_question' } })
    expect(escalated).toHaveLength(2)
    for (const row of escalated) {
      expect(row).toMatchObject({ tier: 'escalated', decidedBy: 'rules' })
      expect((row.situation as { summary: string }).summary).toContain('model overloaded')
    }
  })

  it('gives a question the model keeps leaving out to a person, without asking again about the others', async () => {
    const f = await seed()
    const model = scripted((prompt) => answerJson(idsIn(prompt).filter((id) => id !== f.qReport).map((id) => ok(id))))
    for (let i = 0; i < 4; i += 1) await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => new Date(f.now.getTime() + i * 1000) })
    expect(model.prompts).toHaveLength(3)
    expect(idsIn(model.prompts[1] ?? '')).toEqual([f.qReport])
    const left = await prisma.supervisorDecision.findFirstOrThrow({ where: { subjectId: f.qReport } })
    // Call 1 answered the others and left qReport out; calls 2 and 3 carried only qReport and answered
    // nothing, so they are failed calls with the parser's reason. The card says both (review M6).
    expect((left.situation as { summary: string }).summary).toContain('it was in 3 answer calls without an answer (2 failed; the last: no entry answered a question that was asked')
  })

  it('makes no call when no model is wired: the rules escalate every conductor question (plan B D3)', async () => {
    const f = await seed()
    const report = await supervise({ workspaceId: f.workspaceId, now: () => f.now })
    expect(report.conductorCalls).toBe(0)
    const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, situationKind: 'conductor_question' } })
    expect(rows.map((r) => [r.tier, r.decidedBy])).toEqual([
      ['escalated', 'rules'],
      ['escalated', 'rules'],
    ])
  })

  it('escalates a question the critical lexicon stops, without asking the model about it', async () => {
    const f = await seed({ reportQuestion: 'Which API key do I use for the vendor?' })
    const model = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id))))
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => f.now })
    expect(idsIn(model.prompts[0] ?? '')).toEqual([f.qPaused])
    const row = await prisma.supervisorDecision.findFirstOrThrow({ where: { subjectId: f.qReport } })
    expect(row).toMatchObject({ tier: 'escalated', status: 'pending' })
    expect((row.draft as { body: unknown }).body).toBeNull()
  })

  it('asks about at most ten, paused first, and leaves the rest for the next tick', async () => {
    const f = await seed({ extraReportQuestions: 11 })
    const model = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id))))
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => f.now })
    const first = idsIn(model.prompts[0] ?? '')
    expect(first).toHaveLength(10)
    expect(first[0]).toBe(f.qPaused)
  })

  it('escalates by the rules a run parked on the conductor for more than 30 minutes, beside the batch (spec C5)', async () => {
    const f = await seed()
    const late = new Date(f.now.getTime() + WAITING_STALE_MS + 60_000)
    const model = scripted(() => ({ kind: 'failed', reason: 'down', costUsd: null, tokens: null }))
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => late })
    const stale = await prisma.supervisorDecision.findFirstOrThrow({ where: { subjectId: f.qPaused, situationKind: 'waiting_stale' } })
    expect(stale).toMatchObject({ decidedBy: 'rules', tier: 'escalated' })
    expect(model.prompts).toHaveLength(1)
  })

  it('retires the escalated waiting_stale of a question the batch then answers (Task 2 carry)', async () => {
    const f = await seed()
    const late = new Date(f.now.getTime() + WAITING_STALE_MS + 60_000)
    const down = scripted(() => ({ kind: 'failed', reason: 'down', costUsd: null, tokens: null }))
    await supervise({ workspaceId: f.workspaceId, decider: down.decider, model: 'm', now: () => late })
    const up = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id))))
    await supervise({ workspaceId: f.workspaceId, decider: up.decider, model: 'm', now: () => new Date(late.getTime() + 1000) })
    expect(idsIn(up.prompts[0] ?? '')).toContain(f.qPaused)
    const stale = await prisma.supervisorDecision.findFirstOrThrow({ where: { subjectId: f.qPaused, situationKind: 'waiting_stale' } })
    expect(stale.status).toBe('expired')
    expect(stale.resolvedAt).not.toBeNull()
  })

  it('gives a question of a version with no plan to a person, never skipping it (Task 4 carry)', async () => {
    const f = await seed()
    // The version's tasks lose their packages: the questions keep goal version 1, which has no plan.
    await prisma.task.updateMany({ where: { workspaceId: f.workspaceId }, data: { workPackageId: null } })
    await prisma.workPackage.deleteMany({ where: { workspaceId: f.workspaceId } })
    const model = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id))))
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => f.now })
    expect(model.prompts).toHaveLength(0)
    const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, situationKind: 'conductor_question' } })
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatchObject({ tier: 'escalated', decidedBy: 'rules' })
  })

  // Review I1: the attempts are counted over the question's whole history, so a person resolving
  // the cap's card does not buy three more paid batches.
  it('re-escalates a capped question by the rules after a person rejects its card, without asking again', async () => {
    const f = await seed()
    const model = scripted(() => ({ kind: 'failed', reason: 'model overloaded', costUsd: null, tokens: null }))
    for (let i = 0; i < 4; i += 1) await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => new Date(f.now.getTime() + i * 1000) })
    expect(model.prompts).toHaveLength(3)
    const card = await prisma.supervisorDecision.findFirstOrThrow({ where: { subjectId: f.qPaused, situationKind: 'conductor_question' } })
    expect((await rejectDecision(card.id)).ok).toBe(true)
    const later = new Date(f.now.getTime() + COOLDOWN_MS + 60_000)
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => later })
    expect(model.prompts).toHaveLength(3)
    const rows = await prisma.supervisorDecision.findMany({ where: { subjectId: f.qPaused, situationKind: 'conductor_question' }, orderBy: { createdAt: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ tier: 'escalated', decidedBy: 'rules', status: 'pending' })
  })

  // Review M3: one call per version, but at most the two oldest versions a pass.
  it('batches at most the two oldest versions a pass, and leaves the third for the next tick', async () => {
    const f = await seed()
    const v2 = await addVersion(f, 2)
    const v3 = await addVersion(f, 3)
    const model = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id, { basis: { requirements: [], packages: ['report'], decisions: [] } }))))
    const report = await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => f.now })
    expect(report.conductorCalls).toBe(2)
    const asked = model.prompts.flatMap(idsIn)
    expect(asked).toContain(v2)
    expect(asked).toContain(f.qPaused)
    expect(asked).not.toContain(v3)
    expect(await prisma.supervisorDecision.count({ where: { subjectId: v3 } })).toBe(0)
    expect(await prisma.conductorCall.count({ where: { questionIds: { has: v3 } } })).toBe(0)
  })

  // Review M4: a parked question past its wait that the batch answers in the same pass gets no card.
  it('raises no waiting_stale card for a stale parked question the batch answers in the same pass', async () => {
    const f = await seed()
    const late = new Date(f.now.getTime() + WAITING_STALE_MS + 60_000)
    const model = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id))))
    const report = await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => late })
    expect(report.answered).toBe(2)
    expect(await prisma.supervisorDecision.count({ where: { subjectId: f.qPaused, situationKind: 'waiting_stale' } })).toBe(0)
  })

  it('puts an answer\'s new decision in the next package\'s contract (spec §6)', async () => {
    const f = await seed()
    const model = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id, id === f.qReport ? { newDecision: { title: 'Error shape', decision: '{"error":{"code","message"}}' } } : {}))))
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => f.now })
    const run = await prisma.slaveRun.create({ data: { taskId: f.integrationTaskId, slaveId: f.seatId, status: 'starting' } })
    // The run context writes into the worktree's git exclude file, so the directory must be a repository.
    const worktreePath = mkdtempSync(join(tmpdir(), 'conductor-answers-'))
    execFileSync('git', ['init', '-q', worktreePath])
    const built = await buildRunContext({
      runId: run.id as never,
      kind: 'implementation',
      slaveId: f.seatId as never,
      workspaceId: f.workspaceId as never,
      taskId: f.integrationTaskId as never,
      worktreePath,
      provider: 'claude_code',
    })
    rmSync(worktreePath, { recursive: true, force: true })
    expect(built.prompt).toContain('- Error shape:')
  })

  it('routes an answer\'s hand-off for a finished task to the package that owns the change, and never delivers that answer (spec C4)', async () => {
    const f = await seed()
    const model = scripted((prompt) => answerJson(idsIn(prompt).map((id) => ok(id, id === f.qReport ? { handOff: { package: 'integration', change: 'serve frontend/dist at /' } } : {}))))
    await supervise({ workspaceId: f.workspaceId, decider: model.decider, model: 'm', now: () => f.now })
    const rows = await prisma.packageHandOff.findMany({ where: { workspaceId: f.workspaceId } })
    expect(rows).toEqual([expect.objectContaining({ source: 'answer', toPackageKey: 'integration', status: 'pending', change: 'serve frontend/dist at /' })])
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_package_handed_off' } })
    expect(events.map((e) => (e.payload as { source: string; fromPackage: unknown }).source)).toEqual(['answer'])
    const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { subjectId: f.qReport, situationKind: 'conductor_question' } })
    expect(decision.tier).toBe('applied')
    await deliverAnswers(f.workspaceId)
    const finished = await prisma.slaveMessage.findMany({ where: { replyToId: f.qReport, kind: 'answer' } })
    expect(finished.every((m) => m.deliveredAt === null)).toBe(true)
  })
})
