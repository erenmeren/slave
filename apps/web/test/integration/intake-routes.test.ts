import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as openPOST } from '../../src/app/api/intakes/route.js'
import { DELETE as intakeDELETE, GET as intakeGET } from '../../src/app/api/intakes/[intakeId]/route.js'
import { POST as messagePOST } from '../../src/app/api/intakes/[intakeId]/messages/route.js'
import { POST as acceptPOST } from '../../src/app/api/intakes/[intakeId]/accept/route.js'
import { GET as installationGET, POST as installationPOST } from '../../src/app/api/installation/route.js'

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intake-route-repo-'))
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: dir })
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.com'])
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest run"}}')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

const post = (body: unknown): Request =>
  new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const params = (intakeId: string): { params: Promise<{ intakeId: string }> } => ({ params: Promise.resolve({ intakeId }) })

describe('the intake routes', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "IntakeMessage", "Intake", "GoalVersion", "Task", "Slave", "Team", "Workspace", "InstallationSettings" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  const open = async (): Promise<string> => {
    const response = await openPOST()
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  it('opens a conversation and reads it back empty', async (): Promise<void> => {
    const id = await open()
    const response = await intakeGET(new Request('http://x'), params(id))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { intake: { status: string; messages: unknown[] } }
    expect(body.intake.status).toBe('open')
    expect(body.intake.messages).toEqual([])
  })

  it('404s an intake that does not exist -- from the kind s own suffix, not a list', async (): Promise<void> => {
    const response = await intakeGET(new Request('http://x'), params('00000000-0000-0000-0000-000000000000'))
    expect(response.status).toBe(404)
  })

  it('takes a message, runs detection in THIS process and answers what it found', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await open()
    const response = await messagePOST(post({ text: `the repository is at ${repo}` }), params(id))
    expect(response.status).toBe(200)

    const read = await intakeGET(new Request('http://x'), params(id))
    const body = (await read.json()) as { intake: { messages: { role: string; text: string }[] } }
    expect(body.intake.messages.map((message) => message.role)).toEqual(['human', 'fact'])
    expect(body.intake.messages[1]?.text).toContain('npm test')
  })

  it('409s a blank message and a second message while the first is unanswered', async (): Promise<void> => {
    const id = await open()
    expect((await messagePOST(post({ text: '  ' }), params(id))).status).toBe(409)
    expect((await messagePOST(post({ text: 'hello' }), params(id))).status).toBe(200)
    expect((await messagePOST(post({ text: 'again' }), params(id))).status).toBe(409)
  })

  it('400s a body that is not the shape the route promises', async (): Promise<void> => {
    const id = await open()
    expect((await messagePOST(post({ message: 'wrong key' }), params(id))).status).toBe(400)
    expect((await acceptPOST(post({}), params(id))).status).toBe(400)
  })

  it('accepts a draft and answers with the project it created', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await open()
    await messagePOST(post({ text: `it is at ${repo}` }), params(id))
    const response = await acceptPOST(
      post({
        draft: {
          name: 'From The Route',
          goal: 'Add rate limiting',
          repo: { mode: 'existing', path: repo },
          baseBranch: 'main',
          verifyCommands: [{ command: 'npm test', source: 'detected' }],
          setupCommands: [],
          budgetUsd: 20,
          provider: null,
          team: [],
        },
      }),
      params(id),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { workspaceId: string }
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: body.workspaceId } })).name).toBe('From The Route')
  })

  it('abandons a conversation', async (): Promise<void> => {
    const id = await open()
    expect((await intakeDELETE(new Request('http://x', { method: 'DELETE' }), params(id))).status).toBe(200)
    expect((await prisma.intake.findUniqueOrThrow({ where: { id } })).status).toBe('abandoned')
  })

  it('reads and writes the repositories folder, and says where the answer came from', async (): Promise<void> => {
    const read = await installationGET()
    const before = (await read.json()) as { resolved: string; source: string; reposRoot: string | null }
    expect(before.reposRoot).toBeNull()
    expect(['env', 'default']).toContain(before.source)

    const root = mkdtempSync(join(tmpdir(), 'repos-root-'))
    expect((await installationPOST(post({ reposRoot: root }))).status).toBe(200)
    const after = (await (await installationGET()).json()) as { resolved: string; source: string }
    expect(after).toMatchObject({ resolved: root, source: 'settings' })

    expect((await installationPOST(post({ reposRoot: 'relative' }))).status).toBe(409)
  })
})
