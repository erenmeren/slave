import { prisma } from '@slave-of-ai/db/client'
import { CARD_LOCK_WAIT_MS, sendMessage, withDeliveryLock } from '@slave-of-ai/control'
import { CONDUCTOR_ROLE } from '@slave-of-ai/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Human cards plan B, Task 6: the one route a person decides a question card through. The cookie
 * harness is `control-routes.test.ts`'s (ruling F40): `requirePrincipal` reads `next/headers`, and with
 * no `SLAVEOFAI_SESSION_SECRET` it is loopback mode and never calls `cookies()`; the accounts-mode
 * cases stub the secret and fill the holder.
 */
const { cookieValue } = vi.hoisted(() => ({ cookieValue: { current: null as string | null } }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'slaveofai_session' && cookieValue.current !== null ? { name, value: cookieValue.current } : undefined,
  }),
}))
import { POST as decidePOST } from '../../src/app/api/w/[workspaceId]/supervisor/decisions/[decisionId]/decide/route.js'
import { mintSession } from '../../src/lib/session.js'

const SECRET = '0123456789abcdef0123456789abcdef'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "PackageHandOff", "GoalDecision", "GoalVersion", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "GoalDelivery", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE'

interface CardFixture {
  readonly workspaceId: string
  readonly otherWorkspaceId: string
  readonly deliveryId: string
  readonly questionId: string
  readonly cardId: string
}

/**
 * The control test's fixture (`packages/control/test/integration/cards.test.ts` `seedCard`), seeded
 * here because the route test runs in another package: a conducted goal v1 mid-integration --
 * skeleton (owns backend/package.json, its lockfile and scripts/verify.sh) and api (src/api/**) done,
 * web (src/web/**) with no task, integration's run parked on a question to the conductor -- and a
 * pending escalation card on it, or with `draft` a drafted answer card.
 */
async function seedCard(options: { readonly draft?: string } = {}): Promise<CardFixture> {
  const ws = await prisma.workspace.create({ data: { name: `Decide ${String(Math.random())}`, repoPath: '/nonexistent', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted', goal: 'Ship it.', goalVersion: 1 } })
  const other = await prisma.workspace.create({ data: { name: `Other ${String(Math.random())}`, repoPath: '/nonexistent-other', verifyCommands: ['true'], setupCommands: [] } })
  await prisma.goalVersion.create({ data: { workspaceId: ws.id, version: 1, text: 'Ship it.', sha256: 'x'.repeat(64) } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'E' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Implementer', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id } })
  const delivery = await prisma.goalDelivery.create({ data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1-x', baseCommit: 'a'.repeat(40) } })
  const owned: Record<string, string[]> = { skeleton: ['backend/package.json', 'backend/package-lock.json', 'scripts/verify.sh'], api: ['src/api/**'], integration: [] }
  let integrationTask = ''
  for (const key of ['skeleton', 'api', 'integration'] as const) {
    const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key, title: key, requirementKeys: [], ownedPaths: owned[key] ?? [], interface: '', isIntegration: key === 'integration', templateId: 'tpl' } })
    const status = key === 'integration' ? 'waiting' : 'done'
    const task = await prisma.task.create({ data: { workspaceId: ws.id, title: key, description: 'x', status, requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id, assigneeId: seat.id, integratedAt: status === 'done' ? new Date() : null } })
    if (key === 'integration') integrationTask = task.id
  }
  await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'web', title: 'web', requirementKeys: [], ownedPaths: ['src/web/**'], interface: '', templateId: 'tpl' } })
  const run = await prisma.slaveRun.create({ data: { slaveId: seat.id, taskId: integrationTask, status: 'paused', pauseReason: 'waiting_for_answer', pausedAt: new Date(), provider: 'claude_code' } })
  await prisma.task.update({ where: { id: integrationTask }, data: { activeRunId: run.id } })
  await prisma.checkpoint.create({ data: { runId: run.id, sessionId: 's1', worktreePath: '/tmp/w', pauseFlagPath: '/tmp/p', deniedToolUseIds: [], headCommit: 'a'.repeat(40), dirtyFiles: [], settingsPath: '/tmp/s', hookPath: '/tmp/h', gitAuthorName: 'Ivo', gitAuthorEmail: 'ivo@example.com' } })
  const sent = await sendMessage(run.id, { kind: 'question', body: 'May I add a "start" script to backend/package.json (skeleton)?', recipientRole: CONDUCTOR_ROLE, expectsReply: true, taskId: integrationTask })
  if (!sent.ok) throw new Error(JSON.stringify(sent.error))
  const answer = options.draft !== undefined
  const action = answer ? { kind: 'answer_question', messageId: sent.value.id } : { kind: 'escalate_to_human', summary: 'a person decides' }
  const card = await prisma.supervisorDecision.create({
    data: {
      workspaceId: ws.id, situationKind: 'conductor_question', subjectId: sent.value.id,
      situation: { kind: 'conductor_question', subjectId: sent.value.id, summary: 'A question to the conductor', facts: {} },
      candidates: [{ action, tier: answer ? 'proposed' : 'escalated', why: 'x' }], chosenIndex: 0, action,
      ...(answer ? { draft: { body: options.draft, sources: [], rejectedSources: [], critical: { lexicon: [], model: false }, confidence: 'interpretation' } } : {}),
      rationale: 'x', tier: answer ? 'proposed' : 'escalated', status: 'pending', decidedBy: 'rules',
    },
  })
  return { workspaceId: ws.id, otherWorkspaceId: other.id, deliveryId: delivery.id, questionId: sent.value.id, cardId: card.id }
}

/** A POST to the route; a string body is sent as it is (a malformed one), anything else as JSON, `undefined` as no body. */
const decide = (workspaceId: string, decisionId: string, body?: unknown): Promise<Response> =>
  decidePOST(
    body === undefined
      ? new Request('http://x', { method: 'POST' })
      : new Request('http://x', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ workspaceId, decisionId }) },
  )

const cardOf = (f: CardFixture) => prisma.supervisorDecision.findUniqueOrThrow({ where: { id: f.cardId } })
const questionOf = (f: CardFixture) => prisma.slaveMessage.findUniqueOrThrow({ where: { id: f.questionId } })

/** The card and its question as they were before a refused or unauthorised request: nothing written. */
async function expectUntouched(f: CardFixture): Promise<void> {
  expect(await cardOf(f)).toMatchObject({ status: 'pending', personDecision: null, resolvedAt: null })
  expect((await questionOf(f)).closedAt).toBeNull()
}

describe('POST /api/w/[workspaceId]/supervisor/decisions/[decisionId]/decide (human cards H2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
    cookieValue.current = null
  })

  afterEach((): void => {
    vi.unstubAllEnvs()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  const kinds: readonly { readonly body: Record<string, unknown>; readonly draft?: string; readonly summary: string; readonly status: 'approved' | 'rejected' }[] = [
    { body: { kind: 'send_answer' }, draft: 'Yes, add it.', summary: 'sent the drafted answer', status: 'approved' },
    { body: { kind: 'write_answer', body: 'Yes, but name it "serve".' }, summary: 'answered in their own words', status: 'approved' },
    { body: { kind: 'give_work', target: { package: 'skeleton' }, request: 'Add a start script.' }, summary: 'gave the skeleton package work: Add a start script.', status: 'approved' },
    { body: { kind: 'give_file', path: 'src/api/routes.ts', toPackage: 'web' }, summary: 'gave src/api/routes.ts to the web package', status: 'approved' },
    { body: { kind: 'record_decision', title: 'Scripts', text: 'Every package script lives in backend/package.json.' }, summary: 'recorded the shared decision "Scripts"', status: 'approved' },
    { body: { kind: 'change_requirement', request: 'Ship a start script too.' }, summary: 'changed a requirement: Ship a start script too.', status: 'approved' },
    { body: { kind: 'dismiss', reason: 'not needed' }, summary: 'dismissed the question: not needed', status: 'rejected' },
  ]

  it.each(kinds)('carries $body.kind to the verb and answers with its outcome', async ({ body, draft, summary, status }): Promise<void> => {
    const f = await seedCard(draft === undefined ? {} : { draft })

    const response = await decide(f.workspaceId, f.cardId, body)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, outcome: { decision: body.kind, summary } })
    expect(await cardOf(f)).toMatchObject({ status, personDecision: { decision: { kind: body.kind }, summary } })
    expect((await questionOf(f)).closedAt).not.toBeNull()
  })

  it('records the signed-in person on the card, and answers 401 with no session in accounts mode', async (): Promise<void> => {
    vi.stubEnv('SLAVEOFAI_SESSION_SECRET', SECRET)
    const f = await seedCard()

    const anonymous = await decide(f.workspaceId, f.cardId, { kind: 'dismiss', reason: null })
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual({ error: 'session revoked' })
    await expectUntouched(f)

    const user = await prisma.user.create({ data: { username: 'alice', passwordHash: 'x' } })
    cookieValue.current = await mintSession(SECRET, user.id, new Date())
    const signedIn = await decide(f.workspaceId, f.cardId, { kind: 'dismiss', reason: null })
    expect(signedIn.status).toBe(200)
    expect(await cardOf(f)).toMatchObject({ status: 'rejected', resolvedByUserId: user.id, personDecision: { by: user.id } })
    expect((await questionOf(f)).closedBy).toBe(user.id)
  })

  it('404s a card of another workspace and an unknown one, deciding nothing', async (): Promise<void> => {
    const f = await seedCard()

    const elsewhere = await decide(f.otherWorkspaceId, f.cardId, { kind: 'dismiss', reason: null })
    expect(elsewhere.status).toBe(404)
    expect(await elsewhere.json()).toEqual({ error: 'no such decision in this workspace' })
    expect((await decide(f.workspaceId, '00000000-0000-4000-8000-000000000000', { kind: 'dismiss', reason: null })).status).toBe(404)
    await expectUntouched(f)
  })

  it('400s a body that is no decision, naming what is wrong, and decides nothing', async (): Promise<void> => {
    const f = await seedCard()

    const approve = await decide(f.workspaceId, f.cardId, { kind: 'approve' })
    expect(approve.status).toBe(400)
    expect((await approve.json()).error).toMatch(/^the body must be one decision: .*kind: /u)
    const noReason = await decide(f.workspaceId, f.cardId, { kind: 'dismiss' })
    expect(noReason.status).toBe(400)
    expect((await noReason.json()).error).toContain('reason: ')
    const blank = await decide(f.workspaceId, f.cardId, { kind: 'write_answer', body: '   ' })
    expect(blank.status).toBe(400)
    expect((await blank.json()).error).toContain('body: ')
    const notJson = await decide(f.workspaceId, f.cardId, 'not json')
    expect(notJson.status).toBe(400)
    expect((await notJson.json()).error).toContain('not JSON')
    expect((await decide(f.workspaceId, f.cardId)).status).toBe(400)
    await expectUntouched(f)
  })

  it('409s a card somebody else took first, with a notice naming them by name and when -- never by id (spec §4)', async (): Promise<void> => {
    await prisma.user.create({ data: { id: 'u-alice', username: 'alice', passwordHash: 'x' } })
    const f = await seedCard()
    await prisma.supervisorDecision.update({ where: { id: f.cardId }, data: { status: 'approved', resolvedAt: new Date('2026-10-02T09:30:00.000Z'), resolvedByUserId: 'u-alice' } })

    const response = await decide(f.workspaceId, f.cardId, { kind: 'dismiss', reason: null })

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.notice).toBe('Already closed by alice at 2026-10-02 09:30 UTC.')
    expect(body.error).toContain('not pending')
    expect(JSON.stringify(body)).not.toContain('u-alice')
    expect((await questionOf(f)).closedAt).toBeNull()
  })

  it('409s a card whose question somebody else closed, with the same notice, and writes nothing (spec §4)', async (): Promise<void> => {
    await prisma.user.create({ data: { id: 'u-alice', username: 'alice', passwordHash: 'x' } })
    const f = await seedCard()
    await prisma.slaveMessage.update({ where: { id: f.questionId }, data: { closedAt: new Date('2026-10-02T10:00:00.000Z'), closedReason: 'dismissed', closedBy: 'u-alice', closedNote: 'x' } })

    const response = await decide(f.workspaceId, f.cardId, { kind: 'give_file', path: 'src/api/routes.ts', toPackage: 'web' })

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.notice).toBe('Already closed by alice at 2026-10-02 10:00 UTC.')
    expect(body.error).toContain('was closed')
    expect(JSON.stringify(body)).not.toContain('u-alice')
    expect(await cardOf(f)).toMatchObject({ status: 'pending', personDecision: null })
  })

  it('409s a refusal of the verb with its own sentence and no notice', async (): Promise<void> => {
    const f = await seedCard()

    // An escalation card carries no draft: sending one is not offered.
    const response = await decide(f.workspaceId, f.cardId, { kind: 'send_answer' })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: `supervisor decision ${f.cardId} does not offer "send answer"` })
    await expectUntouched(f)
  })

  it('409s a file given while a merge holds the version, telling the person to decide again (Task 5 carry)', async (): Promise<void> => {
    const f = await seedCard()
    let release = (): void => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = (): void => undefined
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    const holder = withDeliveryLock(f.deliveryId, async () => {
      locked()
      await released
    })
    await holding
    let response: Response
    try {
      response = await decide(f.workspaceId, f.cardId, { kind: 'give_file', path: 'src/api/routes.ts', toPackage: 'web' })
    } finally {
      release()
      await holder
    }

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'the decision was refused, and nothing was changed: goal v1 is busy -- a merge, a check or another decision holds it: decide again in a moment',
    })
    await expectUntouched(f)
    expect((await decide(f.workspaceId, f.cardId, { kind: 'give_file', path: 'src/api/routes.ts', toPackage: 'web' })).status).toBe(200)
  }, CARD_LOCK_WAIT_MS + 20_000)
})
