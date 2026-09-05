import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as artifactGET } from '../../src/app/api/w/[workspaceId]/tasks/[taskId]/artifacts/[artifactId]/route.js'
import { ARTIFACT_READ_LIMIT } from '../../src/lib/artifactLimit.js'

interface Fixture {
  readonly workspace: { readonly id: string; readonly repoPath: string }
  readonly task: { readonly id: string }
  readonly otherTask: { readonly id: string }
}

const repos: string[] = []

async function seed(): Promise<Fixture> {
  const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-web-artifact-'))
  repos.push(repoPath)
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['npm test'], setupCommands: [] },
  })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts: workspace.maxAttempts },
  })
  const otherTask = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add fraud check', description: 'Screen risky orders', maxAttempts: workspace.maxAttempts },
  })
  return { workspace: { id: workspace.id, repoPath }, task: { id: task.id }, otherTask: { id: otherTask.id } }
}

function get(fixture: Fixture, artifactId: string, taskId = fixture.task.id): Promise<Response> {
  return artifactGET(new Request('http://x'), {
    params: Promise.resolve({ workspaceId: fixture.workspace.id, taskId, artifactId }),
  })
}

describe('GET /api/w/[workspaceId]/tasks/[taskId]/artifacts/[artifactId]', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll((): void => {
    for (const repoPath of repos) rmSync(repoPath, { recursive: true, force: true })
  })

  it('404s an artifact row that does not exist', async (): Promise<void> => {
    const fixture = await seed()
    const response = await get(fixture, 'no-such-artifact')
    expect(response.status).toBe(404)
    expect((await response.json()).error).toBe('no such artifact')
  })

  it('404s an artifact row that belongs to another task', async (): Promise<void> => {
    const fixture = await seed()
    const artifactDir = join(fixture.workspace.repoPath, '.slaveofai', 'artifacts', fixture.task.id, 'attempt-01')
    mkdirSync(artifactDir, { recursive: true })
    const filePath = join(artifactDir, '00-npm-test.log')
    writeFileSync(filePath, 'ok\n')
    const artifact = await prisma.artifact.create({
      data: { taskId: fixture.task.id, kind: 'verify', path: filePath },
    })

    // Requested against otherTask -- the row exists, but not under that task.
    const response = await get(fixture, artifact.id, fixture.otherTask.id)
    expect(response.status).toBe(404)
  })

  it('200s a real file under the artifact root, as text/plain', async (): Promise<void> => {
    const fixture = await seed()
    const artifactDir = join(fixture.workspace.repoPath, '.slaveofai', 'artifacts', fixture.task.id, 'attempt-01')
    mkdirSync(artifactDir, { recursive: true })
    const filePath = join(artifactDir, '00-npm-test.log')
    writeFileSync(filePath, 'npm test output\nall green\n')
    const artifact = await prisma.artifact.create({
      data: { taskId: fixture.task.id, kind: 'verify', path: filePath },
    })

    const response = await get(fixture, artifact.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('x-artifact-truncated')).toBeNull()
    expect(await response.text()).toBe('npm test output\nall green\n')
  })

  it('403s a row whose path escapes the artifact root, without reading it', async (): Promise<void> => {
    const fixture = await seed()
    const artifact = await prisma.artifact.create({
      data: { taskId: fixture.task.id, kind: 'verify', path: '/etc/hostname' },
    })

    const response = await get(fixture, artifact.id)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'artifact path outside the artifact root' })
  })

  it('404s a row whose file is gone from disk', async (): Promise<void> => {
    const fixture = await seed()
    const missingPath = join(fixture.workspace.repoPath, '.slaveofai', 'artifacts', fixture.task.id, 'attempt-01', '00-missing.log')
    const artifact = await prisma.artifact.create({
      data: { taskId: fixture.task.id, kind: 'verify', path: missingPath },
    })

    const response = await get(fixture, artifact.id)
    expect(response.status).toBe(404)
    expect((await response.json()).error).toBe('artifact file is gone')
  })

  it('truncates a file over the read limit to its last 256 KiB, with the header set', async (): Promise<void> => {
    const fixture = await seed()
    const artifactDir = join(fixture.workspace.repoPath, '.slaveofai', 'artifacts', fixture.task.id, 'attempt-01')
    mkdirSync(artifactDir, { recursive: true })
    const filePath = join(artifactDir, '00-big.log')
    // 300 KiB: filler, then a marker at the very end so the tail-bound assertion is unambiguous.
    const marker = 'END-OF-LOG'
    const filler = 'x'.repeat(300 * 1024 - marker.length)
    writeFileSync(filePath, filler + marker)
    const artifact = await prisma.artifact.create({
      data: { taskId: fixture.task.id, kind: 'verify', path: filePath },
    })

    const response = await get(fixture, artifact.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-artifact-truncated')).toBe('1')
    const body = await response.text()
    expect(body.length).toBe(ARTIFACT_READ_LIMIT)
    expect(body.endsWith(marker)).toBe(true)
    expect(body).toBe((filler + marker).slice(-ARTIFACT_READ_LIMIT))
  })
})
