// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTAKE_BOOTSTRAP_VERIFY_COMMAND } from '@slave-of-ai/domain'
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

  it('does not lose a first message while the conversation is still opening', async (): Promise<void> => {
    const opening = deferredResponse<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: { method?: string }) => {
        if (url === '/api/intakes' && options?.method === 'POST') return opening.promise
        return new Response(JSON.stringify({ intake: view() }), { status: 200 })
      }),
    )
    render(<IntakeConversation onClose={vi.fn()} />)
    const composer = screen.getByTestId('intake-composer').querySelector('input')
    expect(composer?.disabled).toBe(true)
    expect((screen.getByTestId('intake-send') as HTMLButtonElement).disabled).toBe(true)

    opening.resolve(new Response(JSON.stringify({ ok: true, id: 'intake-1' }), { status: 201 }))
    await waitFor(() => expect(composer?.disabled).toBe(false))
  })

  it.each([
    {
      failure: () => new Response(JSON.stringify({ error: 'intake service unavailable' }), { status: 503 }),
      message: 'intake service unavailable',
    },
    {
      failure: () => Promise.reject(new Error('network disconnected')),
      message: 'network disconnected',
    },
  ])('retries a failed intake open after $message', async ({ failure, message }): Promise<void> => {
    let openAttempts = 0
    const fetchMock = vi.fn(async (url: string, options?: { method?: string }) => {
      if (url === '/api/intakes' && options?.method === 'POST') {
        openAttempts += 1
        if (openAttempts === 1) return await failure()
        return new Response(JSON.stringify({ ok: true, id: 'intake-1' }), { status: 201 })
      }
      return new Response(JSON.stringify({ intake: view() }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-error').textContent).toContain(message))
    const composer = screen.getByTestId('intake-composer').querySelector('input')
    expect(composer?.disabled).toBe(true)

    fireEvent.click(screen.getByTestId('intake-open-retry'))

    await waitFor(() => expect(composer?.disabled).toBe(false))
    expect(screen.queryByTestId('intake-error')).toBeNull()
    expect(openAttempts).toBe(2)
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

  it('offers detected commands and branches only from the selected repository', async (): Promise<void> => {
    const facts = {
      ...FACTS,
      paths: [
        ...FACTS.paths,
        {
          path: '/home/x/other',
          exists: true,
          isRepository: true,
          isEmptyDir: false,
          branches: ['foreign-branch'],
          defaultBranch: 'foreign-branch',
          verify: [{ command: 'npm run foreign', source: 'package.json scripts.foreign' }],
        },
      ],
    }
    stubFetch([
      view({
        status: 'drafted',
        draft: { ...DRAFT, verifyCommands: [{ command: 'npm test', source: 'detected' }] },
        facts,
      }),
    ])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())

    const commands = (screen.getAllByTestId('intake-verify') as HTMLInputElement[]).map((box) =>
      box.getAttribute('data-command'),
    )
    expect(commands).toEqual(['npm test', 'npm run typecheck'])
    const branches = Array.from((screen.getByTestId('intake-base-branch') as HTMLSelectElement).options).map(
      (option) => option.value,
    )
    expect(branches).toEqual(['main', 'develop'])
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

  // M60 §7b, measured on a real project: the card demanded a command for a repository that did not
  // exist yet, which is a question with no honest answer, so the person typed one to get past the
  // button. That typed command is treated as a gate they chose, so `acceptIntake` plants nothing
  // and nothing asks the project to write the script -- the workspace ends up gated on a file that
  // will never exist. The empty list has to be reachable from here or the server-side relaxation
  // cannot be used at all.
  it('creates a NEW repository with no verify command, and says which gate it will start with', async (): Promise<void> => {
    stubFetch([
      view({
        status: 'drafted',
        draft: { ...DRAFT, repo: { mode: 'new', path: null }, verifyCommands: [] },
        facts: FACTS,
      }),
    ])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
    expect((screen.getByTestId('intake-create') as HTMLButtonElement).disabled).toBe(false)
    // Named, not merely permitted: a blank list reads as an oversight, and an operator who thinks
    // the project has no gate at all is the one who invents the command this test exists to stop.
    expect(screen.getByTestId('intake-verify-bootstrap').textContent).toContain(INTAKE_BOOTSTRAP_VERIFY_COMMAND)
  })

  /**
   * FINAL REVIEW, IMPORTANT 8, in the card. Three seats from one persona is legal and real -- a
   * persona has three people -- and the chip list keyed every chip by `templateId`, so three
   * identical keys collided and React rendered ONE. The person approving the team could not see
   * that they were approving three of somebody.
   */
  it('shows one chip per seat, so three people from one persona read as three', async (): Promise<void> => {
    const team = [1, 2, 3].map(() => ({ templateId: 't1', runtimeRoles: ['backend'] }))
    stubFetch([view({ status: 'drafted', draft: { ...DRAFT, team }, facts: FACTS })])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())

    expect(screen.getAllByTestId('intake-team-chip')).toHaveLength(3)
  })

  // The schema refuses a fourth seat from one persona, and `acceptIntake` re-parses, so pressing
  // the button on such a draft is a round trip that can only fail. The button says so instead.
  it('will not create a project asking for a fourth person from one persona', async (): Promise<void> => {
    const team = [1, 2, 3, 4].map(() => ({ templateId: 't1', runtimeRoles: ['backend'] }))
    stubFetch([view({ status: 'drafted', draft: { ...DRAFT, team }, facts: FACTS })])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())

    expect((screen.getByTestId('intake-create') as HTMLButtonElement).disabled).toBe(true)
    // And it says WHICH rule, in the card, rather than leaving a dead button to be puzzled over.
    expect(screen.getByTestId('intake-team-over-limit').textContent).toContain('three')
  })

  it('still demands a command for an EXISTING repository, where code is there to be proven', async (): Promise<void> => {
    stubFetch([view({ status: 'drafted', draft: { ...DRAFT, verifyCommands: [] }, facts: FACTS })])
    render(<IntakeConversation onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('intake-draft')).toBeTruthy())
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
