import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { SUPERVISOR_UPLOAD_MAX_BYTES, SUPERVISOR_UPLOAD_MAX_FILES } from '@slave-of-ai/control'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST } from '../../src/app/api/w/[workspaceId]/supervisor/uploads/route.js'

/**
 * R6 over HTTP: multipart in, `{ attachments }` out, and one status code per way a file can be
 * refused -- 413 too large, 415 a kind nothing here reads, 400 too many and 400 a name that is a
 * path. The project's repository is a real git repository, because the verb commits what it wrote.
 */
const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorMessage", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'

/** A repository with one commit on `main`, `intake-routes.test.ts`' own fixture: `git commit`
 *  refuses a repository with no HEAD, and the upload verb commits. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-uploads-repo-'))
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: dir })
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

async function seed(repoPath: string, options: { readonly archived?: boolean } = {}): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      // `Workspace.name` is unique installation-wide, so the archived fixture needs its own.
      name: options.archived === true ? 'Archived Platform' : 'Checkout Platform',
      repoPath,
      verifyCommands: ['true'],
      setupCommands: [],
      ...(options.archived === true ? { archivedAt: new Date() } : {}),
    },
  })
  return workspace.id
}

/** One multipart request. The field NAME is deliberately varied across the cases below: the route
 *  takes every `File` value in the form, whatever the browser called the input. */
function upload(files: readonly { readonly name: string; readonly bytes: BlobPart; readonly field?: string }[]): Request {
  const form = new FormData()
  for (const file of files) form.append(file.field ?? 'files', new File([file.bytes], file.name))
  return new Request('http://x', { method: 'POST', body: form })
}

/** A request that DECLARES more than the route will ever accept without carrying it: the header is
 *  what the size pre-check reads, and the point of the check is that nothing is decoded first
 *  (fix round 1, I1). */
function oversizeRequest(): Request {
  return new Request('http://x', {
    method: 'POST',
    body: 'not really a hundred megabytes',
    headers: {
      'content-type': 'multipart/form-data; boundary=----x',
      'content-length': String(SUPERVISOR_UPLOAD_MAX_FILES * SUPERVISOR_UPLOAD_MAX_BYTES + 1),
    },
  })
}

/** The text of the brief the first case uploads, named so its byte count can be asserted without
 *  respelling the string. */
const BRIEF = '# What I want\n'

/** The smallest thing that is really a PNG: the eight-byte signature. The allow-list reads the
 *  EXTENSION, so the content only has to be bytes -- but bytes nobody could mistake for text. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const params = (workspaceId: string): { params: Promise<{ workspaceId: string }> } => ({
  params: Promise.resolve({ workspaceId }),
})

interface AttachmentsBody {
  readonly attachments: readonly { readonly path: string; readonly name: string; readonly bytes: number; readonly kind: string }[]
}

describe('the Supervisor uploads route', () => {
  let repoPath: string
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
    repoPath = makeRepo()
    workspaceId = await seed(repoPath)
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('writes a brief and a screenshot into the repository and answers with their paths', async (): Promise<void> => {
    const response = await POST(
      upload([
        { name: 'brief.md', bytes: BRIEF },
        { name: 'screenshot.png', bytes: PNG, field: 'attachment' },
      ]),
      params(workspaceId),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as AttachmentsBody
    expect(body.attachments.map((one) => one.name)).toEqual(['brief.md', 'screenshot.png'])
    expect(body.attachments.map((one) => one.kind)).toEqual(['text', 'image'])
    for (const attachment of body.attachments) {
      expect(attachment.path).toMatch(/^docs\/inbox\/\d{4}-\d{2}-\d{2}-/)
      expect(existsSync(join(repoPath, ...attachment.path.split('/')))).toBe(true)
    }
    expect(body.attachments[0]?.bytes).toBe(Buffer.byteLength(BRIEF))

    // ONE commit for the request, naming what the PERSON called the files.
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repoPath, encoding: 'utf8' }).trim()
    expect(log).toBe('inbox: brief.md, screenshot.png')
  })

  it('415s an extension nothing here can read', async (): Promise<void> => {
    const response = await POST(upload([{ name: 'installer.exe', bytes: 'MZ' }]), params(workspaceId))

    expect(response.status).toBe(415)
    expect(((await response.json()) as { kind: string }).kind).toBe('attachment_kind_not_allowed')
  })

  it('413s a file past the twenty megabyte cap', async (): Promise<void> => {
    const response = await POST(
      upload([{ name: 'huge.md', bytes: new Uint8Array(Buffer.alloc(SUPERVISOR_UPLOAD_MAX_BYTES + 1)) }]),
      params(workspaceId),
    )

    expect(response.status).toBe(413)
    expect(((await response.json()) as { kind: string }).kind).toBe('attachment_too_large')
  })

  /** Refused off the form's ENTRIES, before a byte of any file is copied into a `Buffer`
   *  (fix round 1, I1). The refusal is all this can assert -- and all it needs to: the count is
   *  the only thing the route looked at to answer. */
  it('400s more files than one request may carry, before copying any of them', async (): Promise<void> => {
    const files = Array.from({ length: SUPERVISOR_UPLOAD_MAX_FILES + 1 }, (_unused, index) => ({
      name: `note-${String(index)}.md`,
      bytes: 'note',
    }))

    const response = await POST(upload(files), params(workspaceId))

    expect(response.status).toBe(400)
    const body = (await response.json()) as { kind: string; error: string }
    expect(body.kind).toBe('too_many_attachments')
    // The VERB's own sentence, so a caller reads the same words whichever check answered first.
    expect(body.error).toContain(String(SUPERVISOR_UPLOAD_MAX_FILES))
    expect(existsSync(join(repoPath, 'docs', 'inbox'))).toBe(false)
  })

  it('413s a request that DECLARES more than the whole cap, without reading the body', async (): Promise<void> => {
    const response = await POST(oversizeRequest(), params(workspaceId))

    expect(response.status).toBe(413)
    expect(((await response.json()) as { error: string }).error).toContain(
      String(SUPERVISOR_UPLOAD_MAX_FILES * SUPERVISOR_UPLOAD_MAX_BYTES),
    )
  })

  /** ORDER, proved by the answer (fix round 1, I1): the same oversize declaration that gets a 413
   *  above gets the ARCHIVED refusal here, which is only possible if the one indexed read runs
   *  before the size check and both run before the body is touched. */
  it('answers an archived project before it looks at the size, let alone the body', async (): Promise<void> => {
    const archived = await seed(makeRepo(), { archived: true })

    const response = await POST(oversizeRequest(), params(archived))

    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toContain('archived')
  })

  it('takes a request with no files at all as the no-op the verb says it is', async (): Promise<void> => {
    const response = await POST(upload([]), params(workspaceId))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ attachments: [] })
    // Nothing written and, crucially, nothing COMMITTED: an empty commit would be a record of an
    // event that did not happen.
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repoPath, encoding: 'utf8' }).trim()
    expect(log).toBe('initial')
  })

  it('400s a name that is a path out of the inbox, and writes nothing', async (): Promise<void> => {
    const response = await POST(upload([{ name: '../../etc/passwd.md', bytes: 'root' }]), params(workspaceId))

    expect(response.status).toBe(400)
    expect(((await response.json()) as { kind: string }).kind).toBe('attachment_path_refused')
    expect(existsSync(join(repoPath, 'docs', 'inbox'))).toBe(false)
  })

  it('refuses one bad file by refusing the whole request -- nothing lands', async (): Promise<void> => {
    const response = await POST(
      upload([
        { name: 'brief.md', bytes: '# fine' },
        { name: 'installer.exe', bytes: 'MZ' },
      ]),
      params(workspaceId),
    )

    expect(response.status).toBe(415)
    expect(existsSync(join(repoPath, 'docs', 'inbox'))).toBe(false)
  })

  it('400s a body that is not multipart at all', async (): Promise<void> => {
    const response = await POST(
      new Request('http://x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      params(workspaceId),
    )

    expect(response.status).toBe(400)
  })

  it('409s an archived project and 404s one that does not exist', async (): Promise<void> => {
    const archived = await seed(makeRepo(), { archived: true })
    expect((await POST(upload([{ name: 'a.md', bytes: 'a' }]), params(archived))).status).toBe(409)
    expect(
      (await POST(upload([{ name: 'a.md', bytes: 'a' }]), params('00000000-0000-0000-0000-000000000000'))).status,
    ).toBe(404)
  })
})
