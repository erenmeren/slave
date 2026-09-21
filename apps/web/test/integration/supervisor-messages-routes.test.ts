import { prisma } from '@slave-of-ai/db/client'
import { CHAT_MESSAGE_MAX_CHARS } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET, POST } from '../../src/app/api/w/[workspaceId]/supervisor/messages/route.js'

/**
 * R2's two verbs over HTTP: the composer's POST and the panel's read.
 *
 * The handlers are called directly against the real database, `intake-routes.test.ts`' idiom --
 * there is no server to start, and a `new Request` is exactly what next hands a route.
 */
const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorMessage", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'

async function seed(options: { readonly archived?: boolean } = {}): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      // `Workspace.name` is unique installation-wide, so the archived fixture needs its own.
      name: options.archived === true ? 'Archived Platform' : 'Checkout Platform',
      repoPath: '/tmp/supervisor-messages-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      ...(options.archived === true ? { archivedAt: new Date() } : {}),
    },
  })
  return workspace.id
}

const post = (body: unknown): Request =>
  new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

const params = (workspaceId: string): { params: Promise<{ workspaceId: string }> } => ({
  params: Promise.resolve({ workspaceId }),
})

interface MessagesBody {
  readonly messages: readonly {
    readonly id: string
    readonly seq: number
    readonly role: string
    readonly status: string
    readonly text: string
    readonly attachments: readonly unknown[]
    readonly actions: unknown
    readonly modelCostUsd: number | null
    readonly sourced: boolean
    readonly unmeasured: boolean
    readonly failureReason: string | null
    readonly createdAt: string
  }[]
}

describe('the Supervisor messages route', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
    workspaceId = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('writes the person s line and the reply placeholder, and answers with both ids', async (): Promise<void> => {
    const response = await POST(post({ text: 'why is the checkout task stuck?' }), params(workspaceId))

    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; messageId: string; replyId: string }
    expect(body.ok).toBe(true)

    const rows = await prisma.supervisorMessage.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
    expect(rows.map((row) => [row.role, row.status])).toEqual([
      ['human', 'sent'],
      ['supervisor', 'answering'],
    ])
    expect(rows[0]?.id).toBe(body.messageId)
    expect(rows[1]?.id).toBe(body.replyId)
  })

  it('reads the conversation back, oldest first, with the dates as ISO strings', async (): Promise<void> => {
    await POST(post({ text: 'first' }), params(workspaceId))
    await POST(post({ text: 'second' }), params(workspaceId))

    const response = await GET(new Request('http://x'), params(workspaceId))
    expect(response.status).toBe(200)
    const body = (await response.json()) as MessagesBody

    expect(body.messages.map((message) => message.text)).toEqual(['first', '', 'second', ''])
    expect(body.messages.map((message) => message.seq)).toEqual([0, 1, 2, 3])
    expect(body.messages[0]?.role).toBe('human')
    expect(body.messages[1]?.status).toBe('answering')
    // The projection is the control view unchanged: every field the panel reads is here, and the
    // stamp is a string a browser can parse without a second format to learn.
    expect(body.messages[0]?.attachments).toEqual([])
    expect(body.messages[0]?.actions).toBeNull()
    expect(body.messages[0]?.modelCostUsd).toBeNull()
    expect(body.messages[0]?.sourced).toBe(false)
    expect(body.messages[0]?.unmeasured).toBe(false)
    expect(body.messages[0]?.failureReason).toBeNull()
    expect(new Date(body.messages[0]?.createdAt ?? '').toISOString()).toBe(body.messages[0]?.createdAt)
  })

  it('bounds the read at ?limit= -- the NEWEST end, because a thread is read from the bottom', async (): Promise<void> => {
    await POST(post({ text: 'first' }), params(workspaceId))
    await POST(post({ text: 'second' }), params(workspaceId))

    const response = await GET(new Request('http://x/api?limit=2'), params(workspaceId))
    const body = (await response.json()) as MessagesBody

    expect(body.messages.map((message) => message.seq)).toEqual([2, 3])
  })

  it('409s a message past the cap, with the verb s own sentence and its kind', async (): Promise<void> => {
    const response = await POST(post({ text: 'x'.repeat(CHAT_MESSAGE_MAX_CHARS + 1) }), params(workspaceId))

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; kind: string }
    expect(body.kind).toBe('invalid_message')
    expect(body.error).toContain(String(CHAT_MESSAGE_MAX_CHARS))
    expect(await prisma.supervisorMessage.count({ where: { workspaceId } })).toBe(0)
  })

  it('409s a blank message', async (): Promise<void> => {
    expect((await POST(post({ text: '   ' }), params(workspaceId))).status).toBe(409)
  })

  it('lands an inbox attachment on the stored row, with the kind the PATH says', async (): Promise<void> => {
    const response = await POST(
      post({
        text: 'read this brief',
        // The posted `kind` is a lie (`.md` is text), and the row must not repeat it: the kind is
        // what decides whether the chat prompt inlines the file or only names it (fix round 1, M5).
        attachments: [{ path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 7, kind: 'image' }],
      }),
      params(workspaceId),
    )

    expect(response.status).toBe(200)
    const rows = await prisma.supervisorMessage.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
    expect(rows[0]?.attachments).toEqual([
      { path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 7, kind: 'text' },
    ])

    const read = await GET(new Request('http://x'), params(workspaceId))
    const body = (await read.json()) as MessagesBody
    expect(body.messages[0]?.attachments).toEqual([
      { path: 'docs/inbox/2026-09-20-brief.md', name: 'brief.md', bytes: 7, kind: 'text' },
    ])
  })

  it('409s an attachment that is not a file this conversation put in the inbox', async (): Promise<void> => {
    const response = await POST(
      post({
        text: 'look at this',
        attachments: [{ path: 'src/secrets.md', name: 'secrets.md', bytes: 10, kind: 'text' }],
      }),
      params(workspaceId),
    )

    expect(response.status).toBe(409)
    expect(((await response.json()) as { kind: string }).kind).toBe('attachment_path_refused')
  })

  it('400s a body that is not the shape the route promises', async (): Promise<void> => {
    expect((await POST(post({ message: 'wrong key' }), params(workspaceId))).status).toBe(400)
    expect((await POST(post({ text: 42 }), params(workspaceId))).status).toBe(400)
    expect((await POST(post({ text: 'hi', attachments: [{ path: 'docs/inbox/a.md' }] }), params(workspaceId))).status).toBe(400)
    const malformed = new Request('http://x', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } })
    expect((await POST(malformed, params(workspaceId))).status).toBe(400)
  })

  it('409s every send to an archived project, before the verb runs at all', async (): Promise<void> => {
    const archived = await seed({ archived: true })

    const response = await POST(post({ text: 'anybody there?' }), params(archived))

    expect(response.status).toBe(409)
    expect(await prisma.supervisorMessage.count({ where: { workspaceId: archived } })).toBe(0)
  })

  it('404s a project that does not exist', async (): Promise<void> => {
    const response = await POST(post({ text: 'hello' }), params('00000000-0000-0000-0000-000000000000'))
    expect(response.status).toBe(404)
  })
})
