// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntakeConversation } from '../src/components/projects/IntakeConversation.js'

const routerPush = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush, refresh: vi.fn() }) }))

const FACTS = {
  paths: [
    {
      path: '/home/x/api',
      exists: true,
      isRepository: true,
      isEmptyDir: false,
      branches: ['main', 'develop'],
      defaultBranch: 'main',
      verify: [
        { command: 'npm test', source: 'package.json scripts.test' },
        { command: 'npm run typecheck', source: 'package.json scripts.typecheck' },
      ],
    },
  ],
  reposRoot: '/home/x/projects',
  existingCompanies: [],
  catalogue: [],
}

const DRAFT = {
  name: 'Public API',
  goal: 'Add rate limiting',
  repo: { mode: 'existing', path: '/home/x/api' },
  baseBranch: 'main',
  verifyCommands: [
    { command: 'npm test', source: 'detected' },
    { command: 'npm run typecheck', source: 'detected' },
  ],
  setupCommands: [],
  budgetUsd: 20,
  provider: null,
  team: [{ templateId: 't1', runtimeRoles: ['backend', 'manager'] }],
}

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'intake-1',
    status: 'open',
    draft: null,
    messages: [],
    stepLog: [],
    workspaceId: null,
    failureReason: null,
    callsLeft: 12,
    facts: null,
    ...overrides,
  }
}

/** Answers the four routes the drawer dials, from a queue of intake views the test controls. */
function stubFetch(views: Record<string, unknown>[]): ReturnType<typeof vi.fn> {
  let index = 0
  const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
    if (url === '/api/intakes' && options?.method === 'POST') {
      return new Response(JSON.stringify({ ok: true, id: 'intake-1' }), { status: 201 })
    }
    if (url.endsWith('/accept')) {
      return new Response(JSON.stringify({ ok: true, workspaceId: 'w1' }), { status: 200 })
    }
    if (url.endsWith('/messages')) return new Response(JSON.stringify({ ok: true, seq: 0 }), { status: 200 })
    const next = views[Math.min(index, views.length - 1)]
    index += 1
    return new Response(JSON.stringify({ intake: next }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function deferredResponse<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('IntakeConversation', () => {
  beforeEach(() => {
    routerPush.mockClear()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens one conversation and shows an empty composer', async (): Promise<void> => {
    const fetchMock = stubFetch([view()])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-conversation')).toBeTruthy())
    expect(
      fetchMock.mock.calls.filter(
        ([url, options]) => url === '/api/intakes' && (options as { method?: string } | undefined)?.method === 'POST',
      ),
    ).toHaveLength(1)
    expect(screen.getByTestId('intake-composer')).toBeTruthy()
  })

  it('renders the two kinds of line differently, and a fact card of chips', async (): Promise<void> => {
    stubFetch([
      view({
        status: 'awaiting_reply',
        facts: FACTS,
        messages: [
          { seq: 0, role: 'human', text: 'rate limiting please', facts: null, createdAt: '2026-09-15T09:00:00.000Z' },
          {
            seq: 1,
            role: 'fact',
            text: '/home/x/api is a git repository on main',
            facts: FACTS,
            createdAt: '2026-09-15T09:00:01.000Z',
          },
        ],
      }),
    ])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('intake-message')).toHaveLength(1))
    expect(screen.getAllByTestId('intake-message')[0]?.getAttribute('data-role')).toBe('human')
    expect(screen.getByTestId('intake-fact-card')).toBeTruthy()
    const chips = screen.getAllByTestId('intake-fact-chip').map((chip) => chip.textContent)
    expect(chips).toContain('npm test')
    expect(screen.getAllByTestId('intake-fact-chip')[0]?.getAttribute('title')).toContain('/home/x/api')
  })

  it('says it is thinking while the daemon has the turn, and polls', async (): Promise<void> => {
    const fetchMock = stubFetch([view({ status: 'awaiting_reply' })])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-thinking')).toBeTruthy())
    const before = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_200)
    })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before)
  })

  it('shows the draft card with every detected command checked', async (): Promise<void> => {
    stubFetch([view({ status: 'drafted', draft: DRAFT, facts: FACTS })])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    expect((screen.getByTestId('intake-draft-name') as HTMLInputElement).value).toBe('Public API')
    const boxes = screen.getAllByTestId('intake-verify') as HTMLInputElement[]
    expect(boxes.map((box) => box.getAttribute('data-command'))).toEqual(['npm test', 'npm run typecheck'])
    expect(boxes.every((box) => box.checked)).toBe(true)
    expect(screen.getByTestId('intake-team-chip').getAttribute('data-roles')).toContain('manager')
  })

  it('marks a command the person adds as theirs, never as detected', async (): Promise<void> => {
    stubFetch([view({ status: 'drafted', draft: DRAFT, facts: FACTS })])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    fireEvent.change(screen.getByTestId('intake-verify-add-input'), { target: { value: 'make check' } })
    fireEvent.click(screen.getByTestId('intake-verify-add'))
    const added = (screen.getAllByTestId('intake-verify') as HTMLInputElement[]).find(
      (box) => box.getAttribute('data-command') === 'make check',
    )
    expect(added?.getAttribute('data-source')).toBe('operator')
  })

  it('will not create a project with no verify command left', async (): Promise<void> => {
    stubFetch([view({ status: 'drafted', draft: { ...DRAFT, verifyCommands: [DRAFT.verifyCommands[0]] }, facts: FACTS })])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    fireEvent.click(screen.getAllByTestId('intake-verify')[0] as HTMLInputElement)
    expect((screen.getByTestId('intake-create') as HTMLButtonElement).disabled).toBe(true)
  })

  it('posts the EDITED draft and lands on the project', async (): Promise<void> => {
    const fetchMock = stubFetch([view({ status: 'drafted', draft: DRAFT, facts: FACTS })])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    fireEvent.change(screen.getByTestId('intake-draft-name'), { target: { value: 'Renamed' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('intake-create'))
    })
    const accept = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/accept'))
    expect(JSON.parse(String((accept?.[1] as { body: string }).body)).draft.name).toBe('Renamed')
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/w/w1'))
  })

  it('shows the step log and a Retry when creating stopped part way', async (): Promise<void> => {
    stubFetch([
      view({
        status: 'failed',
        draft: DRAFT,
        facts: FACTS,
        failureReason: 'a project called Public API already exists',
        stepLog: [
          {
            step: 'create_workspace',
            status: 'failed',
            at: '2026-09-15T09:00:00.000Z',
            detail: 'a project called Public API already exists',
          },
        ],
      }),
    ])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-step-log')).toBeTruthy())
    expect(screen.getByTestId('intake-step').getAttribute('data-status')).toBe('failed')
    expect(screen.getByTestId('intake-step').getAttribute('title')).toBe('failed')
    expect(screen.getByTestId('intake-step').textContent).toContain('Stopped')
    expect(screen.getByTestId('intake-step').textContent).not.toContain('failed')
    expect(screen.getByTestId('intake-error').textContent).toContain('already exists')
    expect(screen.getByTestId('intake-retry')).toBeTruthy()
  })

  it('shows the same new repository path accept will use for unicode names', async (): Promise<void> => {
    stubFetch([
      view({
        status: 'drafted',
        draft: { ...DRAFT, name: 'Ödeme Sistemi', repo: { mode: 'new', path: null } },
        facts: { ...FACTS, paths: [] },
      }),
    ])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    expect(screen.getByTestId('intake-repo-new-root').textContent).toContain('/home/x/projects/odeme-sistemi')
  })

  it('joins a trailing-slash repositories root with exactly one separator', async (): Promise<void> => {
    stubFetch([
      view({
        status: 'drafted',
        draft: { ...DRAFT, repo: { mode: 'new', path: null } },
        facts: { ...FACTS, reposRoot: '/home/x/projects/', paths: [] },
      }),
    ])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    expect(screen.getByTestId('intake-repo-new-root').textContent).toContain('/home/x/projects/public-api')
    fireEvent.click(screen.getByTestId('intake-by-hand'))
    await waitFor(() => expect(screen.getByTestId('create-workspace-form')).toBeTruthy())
    expect((screen.getByTestId('create-workspace-repo') as HTMLInputElement).value).toBe('/home/x/projects/public-api')
  })

  it('loads the installation root for drafted new repositories when facts are not present', async (): Promise<void> => {
    const installation = deferredResponse<Response>()
    const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
      if (url === '/api/intakes' && options?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, id: 'intake-1' }), { status: 201 })
      }
      if (url === '/api/installation') return installation.promise
      if (url.endsWith('/accept')) return new Response(JSON.stringify({ ok: true, workspaceId: 'w1' }), { status: 200 })
      return new Response(
        JSON.stringify({ intake: view({ status: 'drafted', draft: { ...DRAFT, repo: { mode: 'new', path: null } }, facts: null }) }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    expect(screen.getByTestId('intake-repo-new-root').textContent).toContain('Loading repositories folder')
    expect((screen.getByTestId('intake-create') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      installation.resolve(new Response(JSON.stringify({ reposRoot: null, resolved: '/srv/repos/', source: 'env' }), { status: 200 }))
      await installation.promise
    })

    await waitFor(() => expect(screen.getByTestId('intake-repo-new-root').textContent).toContain('/srv/repos/public-api'))
    expect((screen.getByTestId('intake-create') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByTestId('intake-create'))
    })
    const accept = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/accept'))
    expect(JSON.parse(String((accept?.[1] as { body: string }).body)).draft.repo).toEqual({ mode: 'new', path: null })
    fireEvent.click(screen.getByTestId('intake-by-hand'))
    await waitFor(() => expect(screen.getByTestId('create-workspace-form')).toBeTruthy())
    expect((screen.getByTestId('create-workspace-repo') as HTMLInputElement).value).toBe('/srv/repos/public-api')
  })

  it('keeps the repositories folder answer when the choice left and came back mid-flight', async (): Promise<void> => {
    const installation = deferredResponse<Response>()
    const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
      if (url === '/api/intakes' && options?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, id: 'intake-1' }), { status: 201 })
      }
      if (url === '/api/installation') return installation.promise
      if (url.endsWith('/accept')) return new Response(JSON.stringify({ ok: true, workspaceId: 'w1' }), { status: 200 })
      return new Response(
        JSON.stringify({ intake: view({ status: 'drafted', draft: { ...DRAFT, repo: { mode: 'new', path: null } }, facts: null }) }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    expect(screen.getByTestId('intake-repo-new-root').textContent).toContain('Loading repositories folder')

    fireEvent.click(screen.getByTestId('intake-repo-existing'))
    fireEvent.click(screen.getByTestId('intake-repo-new-root'))

    await act(async () => {
      installation.resolve(new Response(JSON.stringify({ reposRoot: null, resolved: '/srv/repos', source: 'env' }), { status: 200 }))
      await installation.promise
    })

    await waitFor(() => expect(screen.getByTestId('intake-repo-new-root').textContent).toContain('/srv/repos/public-api'))
    expect((screen.getByTestId('intake-create') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('intake-by-hand') as HTMLButtonElement).disabled).toBe(false)
  })

  it('swaps to the form, pre-filled, when a person would rather type it', async (): Promise<void> => {
    stubFetch([view({ status: 'drafted', draft: DRAFT, facts: FACTS })])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    fireEvent.click(screen.getByTestId('intake-by-hand'))
    await waitFor(() => expect(screen.getByTestId('create-workspace-form')).toBeTruthy())
    expect((screen.getByTestId('create-workspace-name') as HTMLInputElement).value).toBe('Public API')
    expect((screen.getByTestId('create-workspace-repo') as HTMLInputElement).value).toBe('/home/x/api')
    expect((screen.getByTestId('create-workspace-verify') as HTMLTextAreaElement).value).toContain('npm test')
  })

  it('prefills the manual form with the resolved new-root repository path', async (): Promise<void> => {
    stubFetch([
      view({
        status: 'drafted',
        draft: { ...DRAFT, name: '***', repo: { mode: 'new', path: null } },
        facts: { ...FACTS, paths: [] },
      }),
    ])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    fireEvent.click(screen.getByTestId('intake-by-hand'))
    await waitFor(() => expect(screen.getByTestId('create-workspace-form')).toBeTruthy())
    expect((screen.getByTestId('create-workspace-repo') as HTMLInputElement).value).toBe('/home/x/projects/project')
  })
})
