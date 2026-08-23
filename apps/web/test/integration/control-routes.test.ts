import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as pausePOST } from '../../src/app/api/w/[workspaceId]/runs/[runId]/pause/route.js'
import { POST as resumePOST } from '../../src/app/api/w/[workspaceId]/runs/[runId]/resume/route.js'
import { POST as stopPOST } from '../../src/app/api/w/[workspaceId]/runs/[runId]/stop/route.js'
import { POST as messagePOST } from '../../src/app/api/w/[workspaceId]/runs/[runId]/message/route.js'
import { POST as emergencyStopPOST } from '../../src/app/api/w/[workspaceId]/emergency-stop/route.js'
import { POST as goalPOST } from '../../src/app/api/w/[workspaceId]/goal/route.js'

interface Fixture {
  readonly workspace: { readonly id: string; readonly repoPath: string }
  readonly otherWorkspace: { readonly id: string }
  readonly task: { readonly id: string }
  readonly run: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-web-control-'))
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const otherWorkspace = await prisma.workspace.create({
    data: { name: 'Other', repoPath: mkdtempSync(join(tmpdir(), 'aiteamos-web-control-other-')), verifyCommands: ['npm test'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts: workspace.maxAttempts },
  })
  const run = await prisma.agentRun.create({
    data: { taskId: task.id, agentId: agent.id, status: 'working' },
  })
  return {
    workspace: { id: workspace.id, repoPath },
    otherWorkspace: { id: otherWorkspace.id },
    task: { id: task.id },
    run: { id: run.id },
  }
}

/** Mirrors the checkpoint a real pause leaves behind (see packages/control's resume-intent fixture). */
async function pauseWithCheckpoint(fixture: Fixture): Promise<void> {
  await prisma.agentRun.update({ where: { id: fixture.run.id }, data: { status: 'paused', pauseReason: 'human' } })
  await prisma.checkpoint.create({
    data: {
      runId: fixture.run.id,
      sessionId: 'session-123',
      worktreePath: join(fixture.workspace.repoPath, '.aiteamos', 'worktrees', 'T-abcdef12'),
      pauseFlagPath: join(fixture.workspace.repoPath, '.aiteamos', 'runs', fixture.run.id, 'pause.flag'),
      settingsPath: join(fixture.workspace.repoPath, '.aiteamos', 'runs', fixture.run.id, 'settings.json'),
      hookPath: join(fixture.workspace.repoPath, 'scripts', 'pause-gate.sh'),
      gitAuthorName: 'Alex',
      gitAuthorEmail: 'alex@aiteamos.local',
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
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
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
      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
      expect(after.status).toBe('pause_requested')
    })

    it('maps a control refusal to 409 with the refusal text', async (): Promise<void> => {
      await prisma.agentRun.update({ where: { id: fixture.run.id }, data: { status: 'succeeded' } })
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
      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
      expect(after.queuedMessage).toBe('EXTRA.md please')
      expect(after.status).toBe('paused')
    })

    it('treats an absent body as no message rather than 500ing', async (): Promise<void> => {
      await pauseWithCheckpoint(fixture)

      const response = await resumePOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }),
      })
      expect(response.status).toBe(200)
      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
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
      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
      expect(after.queuedMessage).toBeNull()
    })

    it('maps a control refusal (no checkpoint) to 409', async (): Promise<void> => {
      await prisma.agentRun.update({ where: { id: fixture.run.id }, data: { status: 'paused' } })
      const response = await resumePOST(new Request('http://x', { method: 'POST' }), {
        params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('no checkpoint')
    })
  })

  describe('message', () => {
    it('updates the queued instruction while paused and 409s otherwise', async (): Promise<void> => {
      await prisma.agentRun.update({ where: { id: fixture.run.id }, data: { status: 'paused' } })
      const post = (body: unknown): Promise<Response> =>
        messagePOST(
          new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
          { params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }) },
        )

      expect((await post({ message: 'queued while paused' })).status).toBe(200)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).queuedMessage).toBe(
        'queued while paused',
      )

      await prisma.agentRun.update({ where: { id: fixture.run.id }, data: { status: 'working' } })
      expect((await post({ message: 'too late' })).status).toBe(409)
    })

    it('400s when the body has no message string', async (): Promise<void> => {
      await prisma.agentRun.update({ where: { id: fixture.run.id }, data: { status: 'paused' } })
      const response = await messagePOST(
        new Request('http://x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, runId: fixture.run.id }) },
      )
      expect(response.status).toBe(400)
    })

    it('400s on a malformed body', async (): Promise<void> => {
      await prisma.agentRun.update({ where: { id: fixture.run.id }, data: { status: 'paused' } })
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
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).status).toBe('stopped')
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
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: fixture.run.id } })
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
