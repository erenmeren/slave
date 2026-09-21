import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitIn } from '../../src/git.js'
import { refusalText } from '../../src/refusal.js'
import {
  SUPERVISOR_UPLOAD_MAX_BYTES,
  SUPERVISOR_UPLOAD_MAX_FILES,
  storeSupervisorUploads,
} from '../../src/supervisorUploads.js'

const AT = new Date('2026-09-20T11:00:00.000Z')

let workspaceId: string
let repoPath: string

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorMessage", "SupervisorDecision", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
}

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')

const inboxFiles = (): readonly string[] => {
  try {
    return readdirSync(join(repoPath, 'docs', 'inbox')).sort()
  } catch {
    return []
  }
}

describe('storeSupervisorUploads', () => {
  beforeEach(async (): Promise<void> => {
    await reset()
    repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-uploads-'))
    await gitIn(repoPath, 'init', '-b', 'main')
    const workspace = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath, verifyCommands: ['npm test'], setupCommands: [] },
    })
    workspaceId = workspace.id
  })

  afterEach((): void => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('writes two files under docs/inbox with the date and a slug, in ONE commit', async (): Promise<void> => {
    const stored = await storeSupervisorUploads(
      workspaceId,
      [
        { name: 'Competitor Brief.md', bytes: bytes('# Brief\n') },
        { name: 'screenshot.PNG', bytes: bytes('not really a png') },
      ],
      undefined,
      AT,
    )

    expect(stored).toEqual({
      ok: true,
      value: [
        { path: 'docs/inbox/2026-09-20-competitor-brief.md', name: 'Competitor Brief.md', bytes: 8, kind: 'text' },
        { path: 'docs/inbox/2026-09-20-screenshot.png', name: 'screenshot.PNG', bytes: 16, kind: 'image' },
      ],
    })
    expect(readFileSync(join(repoPath, 'docs/inbox/2026-09-20-competitor-brief.md'), 'utf8')).toBe('# Brief\n')
    expect(await gitIn(repoPath, 'log', '--pretty=%s')).toBe('inbox: Competitor Brief.md, screenshot.PNG')
    expect(await gitIn(repoPath, 'log', '-1', '--pretty=%an <%ae>')).toBe('Slave of AI <orchestrator@slaveofai.local>')
    expect(await gitIn(repoPath, 'status', '--porcelain')).toBe('')
  })

  it('commits ONLY the inbox, leaving whatever the operator had staged where it was', async (): Promise<void> => {
    // A checkout is a person's workspace. A bare `git commit` after `git add` would sweep their
    // staged work into a commit called "inbox:", which is why the commit names its paths.
    writeFileSync(join(repoPath, 'THEIRS.md'), 'half-finished\n')
    await gitIn(repoPath, 'add', '--', 'THEIRS.md')

    const stored = await storeSupervisorUploads(workspaceId, [{ name: 'brief.md', bytes: bytes('x') }], undefined, AT)
    expect(stored.ok).toBe(true)

    expect(await gitIn(repoPath, 'log', '-1', '--pretty=%s')).toBe('inbox: brief.md')
    expect(await gitIn(repoPath, 'show', '--name-only', '--pretty=format:', 'HEAD')).toBe('docs/inbox/2026-09-20-brief.md')
    expect(await gitIn(repoPath, 'status', '--porcelain')).toBe('A  THEIRS.md')
  })

  it('gives each extension its kind: text, image, binary', async (): Promise<void> => {
    const stored = await storeSupervisorUploads(
      workspaceId,
      [
        { name: 'rows.csv', bytes: bytes('a,b\n') },
        { name: 'config.yml', bytes: bytes('a: 1\n') },
        { name: 'logo.svg', bytes: bytes('<svg/>') },
        { name: 'contract.pdf', bytes: bytes('%PDF-1.4') },
      ],
      undefined,
      AT,
    )
    if (!stored.ok) throw new Error(refusalText(stored.error))
    expect(stored.value.map((file) => file.kind)).toEqual(['text', 'text', 'image', 'binary'])
  })

  it('numbers a slug that is already taken, in the request and on disk', async (): Promise<void> => {
    const first = await storeSupervisorUploads(workspaceId, [{ name: 'brief.md', bytes: bytes('one') }], undefined, AT)
    expect(first.ok).toBe(true)

    const second = await storeSupervisorUploads(
      workspaceId,
      [
        { name: 'brief.md', bytes: bytes('two') },
        { name: 'BRIEF.md', bytes: bytes('three') },
      ],
      undefined,
      AT,
    )
    if (!second.ok) throw new Error(refusalText(second.error))
    expect(second.value.map((file) => file.path)).toEqual([
      'docs/inbox/2026-09-20-brief-2.md',
      'docs/inbox/2026-09-20-brief-3.md',
    ])
    expect(inboxFiles()).toEqual(['2026-09-20-brief-2.md', '2026-09-20-brief-3.md', '2026-09-20-brief.md'])
  })

  it('refuses an extension that is not on the list, writing and committing nothing', async (): Promise<void> => {
    const refused = await storeSupervisorUploads(
      workspaceId,
      [
        { name: 'brief.md', bytes: bytes('fine') },
        { name: 'payload.exe', bytes: bytes('MZ') },
      ],
      undefined,
      AT,
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.kind).toBe('attachment_kind_not_allowed')
    expect(inboxFiles()).toEqual([])
    expect(await gitIn(repoPath, 'log', '--oneline', '--all')).toBe('')
  })

  it('refuses a file over the size cap and a request over the count cap', async (): Promise<void> => {
    const tooBig = await storeSupervisorUploads(
      workspaceId,
      [{ name: 'huge.md', bytes: Buffer.alloc(SUPERVISOR_UPLOAD_MAX_BYTES + 1) }],
      undefined,
      AT,
    )
    expect(tooBig.ok).toBe(false)
    if (!tooBig.ok) expect(tooBig.error.kind).toBe('attachment_too_large')

    const tooMany = await storeSupervisorUploads(
      workspaceId,
      Array.from({ length: SUPERVISOR_UPLOAD_MAX_FILES + 1 }, (_ignored, index) => ({
        name: `note-${String(index)}.md`,
        bytes: bytes('x'),
      })),
      undefined,
      AT,
    )
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) {
      expect(tooMany.error).toEqual({
        kind: 'too_many_attachments',
        limit: SUPERVISOR_UPLOAD_MAX_FILES,
        count: SUPERVISOR_UPLOAD_MAX_FILES + 1,
      })
    }
    expect(inboxFiles()).toEqual([])
  })

  it('refuses a name that would leave docs/inbox rather than quietly renaming it', async (): Promise<void> => {
    for (const name of ['../../etc/passwd.md', 'sub/dir/brief.md', '..\\evil.md', '..']) {
      const refused = await storeSupervisorUploads(workspaceId, [{ name, bytes: bytes('x') }], undefined, AT)
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error.kind).toBe('attachment_path_refused')
    }
    expect(inboxFiles()).toEqual([])
  })

  it('names a file whose name slugs to nothing rather than writing a path with a hole in it', async (): Promise<void> => {
    const stored = await storeSupervisorUploads(workspaceId, [{ name: '!!!.md', bytes: bytes('x') }], undefined, AT)
    if (!stored.ok) throw new Error(refusalText(stored.error))
    expect(stored.value[0]?.path).toBe('docs/inbox/2026-09-20-file.md')
  })

  it('writes and commits nothing for a request with no files, and refuses an unknown project', async (): Promise<void> => {
    expect(await storeSupervisorUploads(workspaceId, [], undefined, AT)).toEqual({ ok: true, value: [] })
    expect(await gitIn(repoPath, 'log', '--oneline', '--all')).toBe('')

    const missing = await storeSupervisorUploads('nope', [{ name: 'brief.md', bytes: bytes('x') }], undefined, AT)
    expect(missing).toEqual({ ok: false, error: { kind: 'workspace_not_found', workspaceId: 'nope' } })
  })
})
