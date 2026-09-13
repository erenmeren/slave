import { createHmac } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'
import { HOOK_BODY_MAX_BYTES, HOOK_PATH_PREFIX } from '@slave-of-ai/control'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_API_PREFIX } from '../../src/lib/boundary'

/**
 * `POST /api/hooks/[source]/[hookId]` (M54 R1, R3, R10, R11), against a real database.
 *
 * `next/headers` is mocked for the whole file, the `staffing-routes.test.ts` idiom: this route never
 * calls `requirePrincipal` -- that is the point of it -- but the module graph it imports reaches
 * `next/headers` through `@slave-of-ai/control`'s barrel, and `cookies()` outside a Next request
 * throws.
 */
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))

const { POST } = await import('../../src/app/api/hooks/[source]/[hookId]/route')

const ENV_VAR = 'SLAVEOFAI_HOOKS_ROUTE_TEST_SECRET'
const SECRET = 'a-secret-nothing-in-this-repository-stores'
const REPOSITORY = 'acme/checkout'

let workspaceId: string
let hookId: string

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "InboundEvent", "ExternalRepository", "GoalVersion", "ExecutionEvent", "Task", "Workspace" RESTART IDENTITY CASCADE',
  )
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/m54-hooks-route',
      verifyCommands: ['true'],
      setupCommands: [],
      goal: 'Make checkout reliable.',
      goalVersion: 1,
    },
  })
  await prisma.goalVersion.create({
    data: { workspaceId: workspace.id, version: 1, text: 'Make checkout reliable.', sha256: 'seed-v1' },
  })
  const mapping = await prisma.externalRepository.create({
    data: { workspaceId: workspace.id, source: 'github', repositoryFullName: REPOSITORY, secretEnvVar: ENV_VAR },
  })
  workspaceId = workspace.id
  hookId = mapping.hookId
  process.env[ENV_VAR] = SECRET
})

afterEach(() => {
  delete process.env[ENV_VAR]
  vi.restoreAllMocks()
})

const ISSUE = {
  action: 'opened',
  repository: { full_name: REPOSITORY },
  issue: {
    number: 412,
    title: 'Checkout 500s on retry',
    body: 'Reproduced on staging.',
    html_url: 'https://github.com/acme/checkout/issues/412',
  },
}

function deliver(
  body: string,
  options: {
    readonly signature?: string | null
    readonly delivery?: string | null
    readonly event?: string
    readonly headers?: Record<string, string>
  } = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/json', ...options.headers })
  const signature =
    options.signature === undefined
      ? `sha256=${createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex')}`
      : options.signature
  if (signature !== null) headers.set('x-hub-signature-256', signature)
  const deliveryId = options.delivery === undefined ? 'd-1' : options.delivery
  if (deliveryId !== null) headers.set('x-github-delivery', deliveryId)
  headers.set('x-github-event', options.event ?? 'issues')
  return new Request('http://x/api/hooks/github/x', { method: 'POST', body, headers })
}

const params = (source = 'github', id?: string): { params: Promise<{ source: string; hookId: string }> } => ({
  params: Promise.resolve({ source, hookId: id ?? hookId }),
})

const counts = async (): Promise<{ rows: number; events: number; versions: number }> => ({
  rows: await prisma.inboundEvent.count(),
  events: await prisma.executionEvent.count(),
  versions: await prisma.goalVersion.count(),
})

describe('the public prefix is one string (M54 R1)', () => {
  it('is spelled the same in the boundary and in control', () => {
    expect(PUBLIC_API_PREFIX).toBe(HOOK_PATH_PREFIX)
  })
})

describe('every way of being nobody answers the same sentence (M54 R1, R11)', () => {
  it('401s an unsigned delivery and writes nothing at all', async () => {
    const before = await counts()
    const response = await POST(deliver(JSON.stringify(ISSUE), { signature: null }), params())
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthenticated' })
    expect(await counts()).toEqual(before)
  })

  it('401s a corrupt signature, an unknown hook, an unknown source and an unset variable -- byte for byte', async () => {
    const body = JSON.stringify(ISSUE)
    const good = createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex')
    const corrupt = `sha256=${good.slice(0, 63)}${good.endsWith('a') ? 'b' : 'a'}`
    const bodies: string[] = []
    for (const [request, param] of [
      [deliver(body, { signature: corrupt }), params()],
      [deliver(body), params('github', '00000000-0000-4000-8000-000000000000')],
      [deliver(body), params('gitlab')],
    ] as const) {
      const response = await POST(request, param)
      expect(response.status).toBe(401)
      bodies.push(await response.text())
    }
    delete process.env[ENV_VAR]
    const unset = await POST(deliver(body), params())
    expect(unset.status).toBe(401)
    bodies.push(await unset.text())
    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toBe(JSON.stringify({ error: 'unauthenticated' }))
  })

  it('logs ONE bounded line naming which of the six, on stderr and nowhere else (R10)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await POST(deliver(JSON.stringify(ISSUE), { signature: null }), params())
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0]?.[0]).toBe('[hooks] github delivery refused: signature_absent')
    delete process.env[ENV_VAR]
    await POST(deliver(JSON.stringify(ISSUE)), params())
    expect(errors.mock.calls[1]?.[0]).toBe('[hooks] github delivery refused: secret_unset')
  })

  it('never logs the delivery id of a refused delivery -- nothing has authenticated it (R10)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await POST(deliver(JSON.stringify(ISSUE), { signature: null, delivery: 'd-secret-correlation' }), params())
    expect(String(errors.mock.calls[0]?.[0])).not.toContain('d-secret-correlation')
  })
})

describe('the two refusals that are not about identity (M54 R3, R11)', () => {
  it('413s a body over the cap BEFORE any secret is read, and identically for an unknown hook', async () => {
    const before = await counts()
    const huge = JSON.stringify({ ...ISSUE, filler: 'x'.repeat(HOOK_BODY_MAX_BYTES) })
    for (const param of [params(), params('github', '00000000-0000-4000-8000-000000000000')]) {
      const response = await POST(deliver(huge, { signature: null }), param)
      expect(response.status).toBe(413)
    }
    expect(await counts()).toEqual(before)
  })

  it('413s on a lying Content-Length too, before the body is even read', async () => {
    const response = await POST(
      deliver(JSON.stringify(ISSUE), { headers: { 'content-length': String(HOOK_BODY_MAX_BYTES + 1) } }),
      params(),
    )
    expect(response.status).toBe(413)
  })

  it('400s a VERIFIED delivery with no X-GitHub-Delivery -- no key means no idempotency', async () => {
    const before = await counts()
    const response = await POST(deliver(JSON.stringify(ISSUE), { delivery: null }), params())
    expect(response.status).toBe(400)
    expect(await counts()).toEqual(before)
  })

  it('400s a verified delivery whose body is not JSON, and one whose payload will not validate', async () => {
    const notJson = await POST(deliver('{not json', { delivery: 'd-a' }), params())
    expect(notJson.status).toBe(400)
    const noRepository = await POST(
      deliver(JSON.stringify({ zen: 'x', organization: { login: 'acme' } }), { delivery: 'd-b', event: 'ping' }),
      params(),
    )
    expect(noRepository.status).toBe(400)
    expect(await prisma.inboundEvent.count()).toBe(0)
  })

  it('verifies BEFORE it parses -- a malformed body with no signature is still a 401', async () => {
    const response = await POST(deliver('{not json', { signature: null }), params())
    expect(response.status).toBe(401)
  })
})

describe('the three things a 200 says (M54 R4)', () => {
  it('answers actioned, with the version the delivery produced', async () => {
    const response = await POST(deliver(JSON.stringify(ISSUE)), params())
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; inboundEventId: string; goalVersion: number }
    expect(body.status).toBe('actioned')
    expect(body.goalVersion).toBe(2)
    expect(body.inboundEventId).toMatch(/^[0-9a-f-]{36}$/u)
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    expect(workspace.goalVersion).toBe(2)
  })

  it('answers replayed for the SAME delivery id, with the first row id, and moves nothing', async () => {
    const first = (await (await POST(deliver(JSON.stringify(ISSUE)), params())).json()) as { inboundEventId: string }
    const after = await counts()
    const second = await POST(deliver(JSON.stringify(ISSUE)), params())
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ status: 'replayed', inboundEventId: first.inboundEventId })
    expect(await counts()).toEqual(after)
  })

  it('answers ignored with its reason for a repository nobody mapped', async () => {
    const body = JSON.stringify({ ...ISSUE, repository: { full_name: 'acme/nobody-mapped-this' } })
    const response = await POST(deliver(body), params())
    expect(response.status).toBe(200)
    const answered = (await response.json()) as { status: string; reason: string }
    expect(answered.status).toBe('ignored')
    expect(answered.reason).toBe('unmapped_repository')
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('signs over BYTES -- a re-serialised body with the same fields does not verify (E3)', async () => {
    const signed = JSON.stringify({ action: 'opened', repository: { full_name: REPOSITORY } })
    const reordered = JSON.stringify({ repository: { full_name: REPOSITORY }, action: 'opened' })
    const signature = `sha256=${createHmac('sha256', SECRET).update(Buffer.from(signed, 'utf8')).digest('hex')}`
    const response = await POST(deliver(reordered, { signature }), params())
    expect(response.status).toBe(401)
  })
})
