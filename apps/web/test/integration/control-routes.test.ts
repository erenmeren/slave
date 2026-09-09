import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { PROFILE_MAX_CHARS } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as pausePOST } from '../../src/app/api/w/[workspaceId]/runs/[runId]/pause/route.js'
import { POST as resumePOST } from '../../src/app/api/w/[workspaceId]/runs/[runId]/resume/route.js'
import { POST as stopPOST } from '../../src/app/api/w/[workspaceId]/runs/[runId]/stop/route.js'
import { POST as messagePOST } from '../../src/app/api/w/[workspaceId]/runs/[runId]/message/route.js'
import { POST as answerPOST } from '../../src/app/api/w/[workspaceId]/messages/[messageId]/answer/route.js'
import { POST as emergencyStopPOST } from '../../src/app/api/w/[workspaceId]/emergency-stop/route.js'
import { POST as goalPOST } from '../../src/app/api/w/[workspaceId]/goal/route.js'
import { PATCH as profilePATCH } from '../../src/app/api/w/[workspaceId]/slaves/[slaveId]/profile/route.js'
import { PATCH as runtimeRolesPATCH } from '../../src/app/api/w/[workspaceId]/slaves/[slaveId]/runtime-roles/route.js'
import { GET as runContextGET } from '../../src/app/api/w/[workspaceId]/runs/[runId]/context/route.js'

interface Fixture {
  readonly workspace: { readonly id: string; readonly repoPath: string }
  readonly otherWorkspace: { readonly id: string }
  readonly task: { readonly id: string }
  readonly run: { readonly id: string }
  /** M37 t4: the profile and runtime-role routes are addressed at the SLAVE, not at a run. */
  readonly slave: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-web-control-'))
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const otherWorkspace = await prisma.workspace.create({
    data: { name: 'Other', repoPath: mkdtempSync(join(tmpdir(), 'slaveofai-web-control-other-')), verifyCommands: ['npm test'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts: workspace.maxAttempts },
  })
  const run = await prisma.slaveRun.create({
    data: { taskId: task.id, slaveId: slave.id, status: 'working' },
  })
  return {
    workspace: { id: workspace.id, repoPath },
    otherWorkspace: { id: otherWorkspace.id },
    task: { id: task.id },
    run: { id: run.id },
    slave: { id: slave.id },
  }
}

/** Mirrors the checkpoint a real pause leaves behind (see packages/control's resume-intent fixture). */
async function pauseWithCheckpoint(fixture: Fixture): Promise<void> {
  await prisma.slaveRun.update({ where: { id: fixture.run.id }, data: { status: 'paused', pauseReason: 'human' } })
  await prisma.checkpoint.create({
    data: {
      runId: fixture.run.id,
      sessionId: 'session-123',
      worktreePath: join(fixture.workspace.repoPath, '.slaveofai', 'worktrees', 'T-abcdef12'),
      pauseFlagPath: join(fixture.workspace.repoPath, '.slaveofai', 'runs', fixture.run.id, 'pause.flag'),
      settingsPath: join(fixture.workspace.repoPath, '.slaveofai', 'runs', fixture.run.id, 'settings.json'),
      hookPath: join(fixture.workspace.repoPath, 'scripts', 'pause-gate.sh'),
      gitAuthorName: 'Alex',
      gitAuthorEmail: 'alex@slaveofai.local',
      lastToolUseId: 'toolu_01ABC',
      lastToolName: 'Edit',
      numTurns: 3,
      deniedToolUseIds: ['toolu_01ABC'],
      headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      dirtyFiles: ['src/index.ts'],
      cumulativeCostUsd: 0.42,
      cumulativeTokens: 1234,
    },
  })
}

describe('the control routes', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "RunContext", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  describe('pause', () => {
    it('pauses a working run and returns 200', async (): Promise<void> => {
      const response = await pausePOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
      expect(after.status).toBe('pause_requested')
    })

    it('maps a control refusal to 409 with the refusal text', async (): Promise<void> => {
      await prisma.slaveRun.update({ where: { id: fixture.run.id }, data: { status: 'succeeded' } })
      const response = await pausePOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('succeeded')
    })

    it('404s a run that belongs to another workspace', async (): Promise<void> => {
      const response = await pausePOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.otherWorkspace.id, runId: fixture.run.id }),
      })
      expect(response.status).toBe(404)
    })

    it('404s an unknown run', async (): Promise<void> => {
      const response = await pausePOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: '00000000-0000-4000-8000-000000000000' }),
      })
      expect(response.status).toBe(404)
    })
  })

  describe('resume', () => {
    it('accepts an optional message body and records the intent', async (): Promise<void> => {
      await pauseWithCheckpoint(fixture)

      const response = await resumePOST(
        new Request('http://x', {
          method: 'POST',
          body: JSON.stringify({ message: 'EXTRA.md please' }),
          headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }) },
      )
      expect(response.status).toBe(200)
      const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
      expect(after.queuedMessage).toBe('EXTRA.md please')
      expect(after.status).toBe('paused')
    })

    it('treats an absent body as no message rather than 500ing', async (): Promise<void> => {
      await pauseWithCheckpoint(fixture)

      const response = await resumePOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }),
      })
      expect(response.status).toBe(200)
      const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
      expect(after.queuedMessage).toBeNull()
      expect(after.resumeRequestedAt).not.toBeNull()
    })

    it('treats a malformed body as no message rather than 500ing', async (): Promise<void> => {
      await pauseWithCheckpoint(fixture)

      const response = await resumePOST(
        new Request('http://x', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }) },
      )
      expect(response.status).toBe(200)
      const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
      expect(after.queuedMessage).toBeNull()
    })

    it('maps a control refusal (no checkpoint) to 409', async (): Promise<void> => {
      await prisma.slaveRun.update({ where: { id: fixture.run.id }, data: { status: 'paused' } })
      const response = await resumePOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('no checkpoint')
    })
  })

  // M36 t3 fix round 1, finding 1: the panel's "answer" button used to POST the run's `resume`
  // route, which wrote no message -- the asker resumed and its question stayed unanswered forever.
  describe('answer', () => {
    /** The question a waiting run is parked on, written the way the ask path writes it. */
    async function askAQuestion(workspaceId: string): Promise<string> {
      const question = await prisma.slaveMessage.create({
        data: {
          slaveId: (await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: fixture.workspace.id } } })).id,
          workspaceId,
          senderRunId: fixture.run.id,
          taskId: fixture.task.id,
          recipientRole: 'product',
          threadId: 'thread-1',
          kind: 'question',
          body: 'Which queue should retries land on?',
          actor: 'slave',
          expectsReply: true,
        },
      })
      return question.id
    }

    const post = (workspaceId: string, messageId: string, body: unknown): Promise<Response> =>
      answerPOST(
        new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId, messageId }) },
      )

    it('writes a human answer in the question thread and returns 200', async (): Promise<void> => {
      const questionId = await askAQuestion(fixture.workspace.id)

      const response = await post(fixture.workspace.id, questionId, { answer: 'payments-retry' })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      const answer = await prisma.slaveMessage.findFirstOrThrow({ where: { kind: 'answer' } })
      expect(answer.actor).toBe('human')
      expect(answer.replyToId).toBe(questionId)
      expect(answer.senderRunId).toBeNull()
      expect(answer.body).toBe('payments-retry')
      expect(answer.threadId).toBe('thread-1')
      expect(answer.deliveredAt).toBeNull()
    })

    it('404s a question that belongs to another workspace', async (): Promise<void> => {
      const questionId = await askAQuestion(fixture.workspace.id)

      const response = await post(fixture.otherWorkspace.id, questionId, { answer: 'payments-retry' })

      expect(response.status).toBe(404)
      expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(0)
    })

    it('404s an unknown message', async (): Promise<void> => {
      const response = await post(fixture.workspace.id, '00000000-0000-4000-8000-000000000000', { answer: 'x' })
      expect(response.status).toBe(404)
    })

    it('400s a body that carries no answer string, writing nothing', async (): Promise<void> => {
      const questionId = await askAQuestion(fixture.workspace.id)

      expect((await post(fixture.workspace.id, questionId, { message: 'wrong key' })).status).toBe(400)
      const malformed = await answerPOST(
        new Request('http://x', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, messageId: questionId }) },
      )
      expect(malformed.status).toBe(400)
      expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(0)
    })

    it('maps a control refusal to 409 with the refusal text', async (): Promise<void> => {
      const questionId = await askAQuestion(fixture.workspace.id)

      const blank = await post(fixture.workspace.id, questionId, { answer: '   ' })
      expect(blank.status).toBe(409)
      expect((await blank.json()).error).toContain('non-empty')

      const information = await prisma.slaveMessage.create({
        data: {
          slaveId: (await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: fixture.workspace.id } } })).id,
          workspaceId: fixture.workspace.id,
          threadId: 'thread-2',
          kind: 'information',
          body: 'FYI',
          actor: 'slave',
        },
      })
      const notAQuestion = await post(fixture.workspace.id, information.id, { answer: 'payments-retry' })
      expect(notAQuestion.status).toBe(409)
      expect((await notAQuestion.json()).error).toContain('not a question')
    })

    it('writes one row when the same answer is posted twice', async (): Promise<void> => {
      const questionId = await askAQuestion(fixture.workspace.id)

      await post(fixture.workspace.id, questionId, { answer: 'payments-retry' })
      const second = await post(fixture.workspace.id, questionId, { answer: 'payments-retry' })

      expect(second.status).toBe(200)
      expect(await prisma.slaveMessage.count({ where: { kind: 'answer' } })).toBe(1)
    })
  })

  // M37 t4. Spec §1: model output never writes a profile -- the route calls `setProfile` and
  // nothing else, so every rule about what a profile may be lives in the verb and is only
  // TRANSLATED here (400 for a body this route cannot read, `refusalStatus` for the rest).
  describe('profile', () => {
    const patch = (workspaceId: string, slaveId: string, body: unknown): Promise<Response> =>
      profilePATCH(
        new Request('http://x', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId, slaveId }) },
      )

    it('writes the slave-level profile and records one slave.profile_changed event', async (): Promise<void> => {
      const response = await patch(fixture.workspace.id, fixture.slave.id, { profile: 'You are careful with payments.' })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).profile).toBe(
        'You are careful with payments.',
      )
      expect(await prisma.executionEvent.count({ where: { type: 'slave_profile_changed' } })).toBe(1)
    })

    it('clears the override on an explicit null', async (): Promise<void> => {
      await patch(fixture.workspace.id, fixture.slave.id, { profile: 'You are careful with payments.' })

      const response = await patch(fixture.workspace.id, fixture.slave.id, { profile: null })

      expect(response.status).toBe(200)
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).profile).toBeNull()
    })

    it('404s a slave in another workspace, and an unknown slave, writing nothing', async (): Promise<void> => {
      const crossWorkspace = await patch(fixture.otherWorkspace.id, fixture.slave.id, { profile: 'not yours' })
      expect(crossWorkspace.status).toBe(404)

      const unknown = await patch(fixture.workspace.id, '00000000-0000-4000-8000-000000000000', { profile: 'nobody' })
      expect(unknown.status).toBe(404)

      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).profile).toBeNull()
      expect(await prisma.executionEvent.count({ where: { type: 'slave_profile_changed' } })).toBe(0)
    })

    it('400s a body that carries no profile field, a non-string profile, and unparseable JSON', async (): Promise<void> => {
      expect((await patch(fixture.workspace.id, fixture.slave.id, {})).status).toBe(400)
      expect((await patch(fixture.workspace.id, fixture.slave.id, { profile: 5 })).status).toBe(400)

      const malformed = await profilePATCH(
        new Request('http://x', { method: 'PATCH', body: 'not json', headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, slaveId: fixture.slave.id }) },
      )
      expect(malformed.status).toBe(400)
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).profile).toBeNull()
    })

    it("maps the verb's own refusal to 409 with its text", async (): Promise<void> => {
      const response = await patch(fixture.workspace.id, fixture.slave.id, { profile: 'x'.repeat(PROFILE_MAX_CHARS + 1) })

      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain(String(PROFILE_MAX_CHARS))
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).profile).toBeNull()
    })
  })

  // M37 t4. `runtimeRoles` is the one dispatch match (spec §5), so this route is how a worker
  // becomes dispatchable at all -- including the empty set, which is a real (parked) state and
  // never a refusal.
  describe('runtime-roles', () => {
    const patch = (workspaceId: string, slaveId: string, body: unknown): Promise<Response> =>
      runtimeRolesPATCH(
        new Request('http://x', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId, slaveId }) },
      )

    it('replaces the set and records one slave.runtime_roles_changed event', async (): Promise<void> => {
      const response = await patch(fixture.workspace.id, fixture.slave.id, { roles: ['backend', 'reviewer'] })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).runtimeRoles).toEqual([
        'backend',
        'reviewer',
      ])
      expect(await prisma.executionEvent.count({ where: { type: 'slave_runtime_roles_changed' } })).toBe(1)
    })

    it('accepts the empty set: parked is a state, not a refusal', async (): Promise<void> => {
      await patch(fixture.workspace.id, fixture.slave.id, { roles: ['backend'] })

      const response = await patch(fixture.workspace.id, fixture.slave.id, { roles: [] })

      expect(response.status).toBe(200)
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).runtimeRoles).toEqual([])
    })

    it('404s a slave in another workspace, and an unknown slave, writing nothing', async (): Promise<void> => {
      expect((await patch(fixture.otherWorkspace.id, fixture.slave.id, { roles: ['backend'] })).status).toBe(404)
      expect(
        (await patch(fixture.workspace.id, '00000000-0000-4000-8000-000000000000', { roles: ['backend'] })).status,
      ).toBe(404)

      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).runtimeRoles).toEqual([])
      expect(await prisma.executionEvent.count({ where: { type: 'slave_runtime_roles_changed' } })).toBe(0)
    })

    it('400s a body with no roles array, a non-string entry, and unparseable JSON', async (): Promise<void> => {
      expect((await patch(fixture.workspace.id, fixture.slave.id, {})).status).toBe(400)
      expect((await patch(fixture.workspace.id, fixture.slave.id, { roles: 'backend' })).status).toBe(400)
      expect((await patch(fixture.workspace.id, fixture.slave.id, { roles: ['backend', 7] })).status).toBe(400)

      const malformed = await runtimeRolesPATCH(
        new Request('http://x', { method: 'PATCH', body: 'not json', headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, slaveId: fixture.slave.id }) },
      )
      expect(malformed.status).toBe(400)
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).runtimeRoles).toEqual([])
    })

    it("maps the verb's own refusal to 409 with its reason", async (): Promise<void> => {
      const response = await patch(fixture.workspace.id, fixture.slave.id, { roles: ['backend', 'backend'] })

      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('named twice')
      expect((await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slave.id } })).runtimeRoles).toEqual([])
    })
  })

  // M37 t4: what a run was told, read back. The row is written before the spawn (Task 2), so a
  // run that started always has one -- and a run without one is indistinguishable from a run that
  // does not exist as far as this read is concerned.
  describe('run context', () => {
    const manifest = {
      kind: 'implementation',
      sections: [
        { kind: 'profile', origin: 'slave', sha256: 'a'.repeat(64) },
        { kind: 'skills', copied: ['writing-plans'], missing: ['brainstorming'], shadowedByRepo: [], provider_unsupported: false, no_worktree: false },
        { kind: 'task', taskId: 'task-1' },
      ],
    }

    const get = (workspaceId: string, runId: string): Promise<Response> =>
      runContextGET(new Request('http://x'), { params: Promise.resolve({ workspaceId, runId }) })

    it('returns the recorded prompt and manifest', async (): Promise<void> => {
      await prisma.runContext.create({ data: { runId: fixture.run.id, prompt: 'You are careful.', sections: manifest } })

      const response = await get(fixture.workspace.id, fixture.run.id)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ prompt: 'You are careful.', manifest })
    })

    it('404s a run in another workspace', async (): Promise<void> => {
      await prisma.runContext.create({ data: { runId: fixture.run.id, prompt: 'You are careful.', sections: manifest } })

      expect((await get(fixture.otherWorkspace.id, fixture.run.id)).status).toBe(404)
    })

    it('404s an unknown run, and a run that recorded no context', async (): Promise<void> => {
      expect((await get(fixture.workspace.id, '00000000-0000-4000-8000-000000000000')).status).toBe(404)

      const noContext = await get(fixture.workspace.id, fixture.run.id)
      expect(noContext.status).toBe(404)
      expect((await noContext.json()).error).toEqual(expect.any(String))
    })

    it('refuses a stored manifest this version cannot read rather than serving a shape nobody validated', async (): Promise<void> => {
      await prisma.runContext.create({
        data: { runId: fixture.run.id, prompt: 'You are careful.', sections: { kind: 'implementation', sections: [{ kind: 'not_a_section' }] } },
      })

      const response = await get(fixture.workspace.id, fixture.run.id)

      expect(response.status).toBe(500)
      expect((await response.json()).error).toContain('cannot read')
    })
  })

  describe('message', () => {
    it('updates the queued instruction while paused and 409s otherwise', async (): Promise<void> => {
      await prisma.slaveRun.update({ where: { id: fixture.run.id }, data: { status: 'paused' } })
      const post = (body: unknown): Promise<Response> =>
        messagePOST(
          new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
          { params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }) },
        )

      expect((await post({ message: 'queued while paused' })).status).toBe(200)
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).queuedMessage).toBe(
        'queued while paused',
      )

      await prisma.slaveRun.update({ where: { id: fixture.run.id }, data: { status: 'working' } })
      expect((await post({ message: 'too late' })).status).toBe(409)
    })

    it('400s when the body has no message string', async (): Promise<void> => {
      await prisma.slaveRun.update({ where: { id: fixture.run.id }, data: { status: 'paused' } })
      const response = await messagePOST(
        new Request('http://x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }) },
      )
      expect(response.status).toBe(400)
    })

    it('400s on a malformed body', async (): Promise<void> => {
      await prisma.slaveRun.update({ where: { id: fixture.run.id }, data: { status: 'paused' } })
      const response = await messagePOST(
        new Request('http://x', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }) },
      )
      expect(response.status).toBe(400)
    })
  })

  describe('stop', () => {
    it('concludes the run and blocks the task through the route', async (): Promise<void> => {
      await prisma.task.update({ where: { id: fixture.task.id }, data: { status: 'running', activeRunId: fixture.run.id } })
      const response = await stopPOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }),
      })
      expect(response.status).toBe(200)
      expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).status).toBe('stopped')
      expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.task.id } })).status).toBe('blocked')
    })

    it('404s a run that belongs to another workspace', async (): Promise<void> => {
      const response = await stopPOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.otherWorkspace.id, runId: fixture.run.id }),
      })
      expect(response.status).toBe(404)
    })
  })

  describe('emergency-stop', () => {
    it('halts the workspace and pause-requests its working run, returning 200', async (): Promise<void> => {
      const response = await emergencyStopPOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })
      expect(workspace.haltedReason).not.toBeNull()
      const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
      expect(run.status).toBe('pause_requested')
    })

    it('404s JSON { error } on an unknown workspace id', async (): Promise<void> => {
      const response = await emergencyStopPOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: '00000000-0000-4000-8000-000000000000' }),
      })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: expect.any(String) })
    })

    it('posting twice still returns 200 (already halted is not an error)', async (): Promise<void> => {
      const first = await emergencyStopPOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id }),
      })
      expect(first.status).toBe(200)

      const second = await emergencyStopPOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id }),
      })
      expect(second.status).toBe(200)
      expect(await second.json()).toEqual({ ok: true })
    })
  })

  describe('goal', () => {
    const post = (workspaceId: string, body: unknown): Promise<Response> =>
      goalPOST(
        new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId }) },
      )

    it('(a) sets the column and records one workspace.goal_set event, returning 200', async (): Promise<void> => {
      const response = await post(fixture.workspace.id, { goal: 'ship the checkout redesign' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })

      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })
      expect(workspace.goal).toBe('ship the checkout redesign')

      const events = await prisma.executionEvent.findMany({
        where: { workspaceId: fixture.workspace.id, type: 'workspace_goal_set' },
      })
      expect(events).toHaveLength(1)
    })

    it('(b) 400s on a non-string goal and on an unparseable body', async (): Promise<void> => {
      const nonString = await post(fixture.workspace.id, { goal: 5 })
      expect(nonString.status).toBe(400)

      const malformed = await goalPOST(
        new Request('http://x', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id }) },
      )
      expect(malformed.status).toBe(400)
    })

    it('(c) 409s with the invalid_goal text on a blank goal', async (): Promise<void> => {
      const response = await post(fixture.workspace.id, { goal: '  ' })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe('a goal must be a non-empty text')
    })

    it('(d) 404s an unknown workspace', async (): Promise<void> => {
      const response = await post('00000000-0000-4000-8000-000000000000', { goal: 'ship it' })
      expect(response.status).toBe(404)
    })
  })
})
