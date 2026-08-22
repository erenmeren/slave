import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as addDependencyPOST } from '../../src/app/api/w/[workspaceId]/tasks/[taskId]/dependencies/route.js'
import { DELETE as removeDependencyDELETE } from '../../src/app/api/w/[workspaceId]/tasks/[taskId]/dependencies/[dependsOnTaskId]/route.js'

interface Fixture {
  readonly workspace: { readonly id: string }
  readonly otherWorkspace: { readonly id: string }
  readonly task: { readonly id: string }
  readonly otherTask: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-web-dependency-'))
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['npm test'], setupCommands: ['npm ci'] },
  })
  const otherWorkspace = await prisma.workspace.create({
    data: { name: 'Other', repoPath: mkdtempSync(join(tmpdir(), 'aiteamos-web-dependency-other-')), verifyCommands: ['npm test'], setupCommands: [] },
  })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts: workspace.maxAttempts },
  })
  const otherTask = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add fraud check', description: 'Screen risky orders', maxAttempts: workspace.maxAttempts },
  })
  return {
    workspace: { id: workspace.id },
    otherWorkspace: { id: otherWorkspace.id },
    task: { id: task.id },
    otherTask: { id: otherTask.id },
  }
}

describe('the dependency routes', () => {
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

  describe('POST (add dependency)', () => {
    it('adds the dependency and returns 200', async (): Promise<void> => {
      const response = await addDependencyPOST(
        new Request('http://x', {
          method: 'POST',
          body: JSON.stringify({ dependsOnTaskId: fixture.otherTask.id }),
          headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, taskId: fixture.task.id }) },
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      const row = await prisma.taskDependency.findUnique({
        where: { taskId_dependsOnTaskId: { taskId: fixture.task.id, dependsOnTaskId: fixture.otherTask.id } },
      })
      expect(row).not.toBeNull()
    })

    it('maps a dependency cycle refusal to 409 with the cycle text', async (): Promise<void> => {
      await prisma.taskDependency.create({ data: { taskId: fixture.otherTask.id, dependsOnTaskId: fixture.task.id } })

      const response = await addDependencyPOST(
        new Request('http://x', {
          method: 'POST',
          body: JSON.stringify({ dependsOnTaskId: fixture.otherTask.id }),
          headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, taskId: fixture.task.id }) },
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('cycle')
    })

    it('400s a body missing dependsOnTaskId', async (): Promise<void> => {
      const response = await addDependencyPOST(
        new Request('http://x', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, taskId: fixture.task.id }) },
      )
      expect(response.status).toBe(400)
    })

    it('400s on a malformed body', async (): Promise<void> => {
      const response = await addDependencyPOST(
        new Request('http://x', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ workspaceId: fixture.workspace.id, taskId: fixture.task.id }) },
      )
      expect(response.status).toBe(400)
    })

    it('404s a task from another workspace', async (): Promise<void> => {
      const response = await addDependencyPOST(
        new Request('http://x', {
          method: 'POST',
          body: JSON.stringify({ dependsOnTaskId: fixture.otherTask.id }),
          headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({ workspaceId: fixture.otherWorkspace.id, taskId: fixture.task.id }) },
      )
      expect(response.status).toBe(404)
    })
  })

  describe('DELETE (remove dependency)', () => {
    it('removes the dependency and returns 200', async (): Promise<void> => {
      await prisma.taskDependency.create({ data: { taskId: fixture.task.id, dependsOnTaskId: fixture.otherTask.id } })

      const response = await removeDependencyDELETE(new Request('http://x', { method: 'DELETE' }), {
        params: Promise.resolve({
          workspaceId: fixture.workspace.id,
          taskId: fixture.task.id,
          dependsOnTaskId: fixture.otherTask.id,
        }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      const row = await prisma.taskDependency.findUnique({
        where: { taskId_dependsOnTaskId: { taskId: fixture.task.id, dependsOnTaskId: fixture.otherTask.id } },
      })
      expect(row).toBeNull()
    })

    it('maps a missing dependency refusal to 409', async (): Promise<void> => {
      const response = await removeDependencyDELETE(new Request('http://x', { method: 'DELETE' }), {
        params: Promise.resolve({
          workspaceId: fixture.workspace.id,
          taskId: fixture.task.id,
          dependsOnTaskId: fixture.otherTask.id,
        }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('does not depend on')
    })
  })
})
