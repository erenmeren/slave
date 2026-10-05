// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NewProject } from '../src/components/new/NewProject'
import { stubBrowser, stubFetch } from './fixtures/dom'

const replace = vi.fn()
const push = vi.fn()
let search = new URLSearchParams()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace, refresh: vi.fn() }), useSearchParams: () => search }))

beforeAll(() => stubBrowser())
afterEach(() => {
  vi.unstubAllGlobals()
  search = new URLSearchParams()
})

const drafted = {
  id: 'in-1',
  status: 'drafted',
  draft: { name: 'Recipe box', goal: 'Save recipes.', repo: { mode: 'new', path: null }, baseBranch: 'main', verifyCommands: [], setupCommands: [], budgetUsd: 15, provider: 'claude_code', autoMerge: true, autonomy: 'act', delivery: 'conducted', team: [] },
  messages: [{ seq: 1, role: 'human', text: 'A recipe box.', facts: null }],
  stepLog: [],
  workspaceId: null,
  failureReason: null,
  callsLeft: 4,
  facts: null,
}

function answer(url: string): { body: unknown } {
  if (url === '/api/installation') return { body: { resolved: '/home/x/projects' } }
  if (url === '/api/intakes') return { body: { ok: true, id: 'in-1' } }
  if (url.endsWith('/accept')) return { body: { ok: true, workspaceId: 'ws-9' } }
  return { body: { intake: drafted } }
}

describe('New project (lead UX design section 6.2)', () => {
  it('opens a conversation and puts its id in the address', async () => {
    stubFetch((url) => (url === '/api/intakes/in-1' ? { body: { intake: { ...drafted, status: 'open', draft: null, messages: [] } } } : answer(url)))
    await act(async () => {
      render(<NewProject />)
    })
    expect(replace).toHaveBeenCalledWith('/new?intake=in-1')
    expect(screen.getByTestId('project-card-draft').textContent).toContain('The details appear here')
    expect(screen.getByTestId('intake-composer')).toBeTruthy()
  })

  it('asks how much the project may spend, with Both chosen, and starts it with the budget and the time limit', async () => {
    search = new URLSearchParams('intake=in-1')
    const fetchMock = stubFetch(answer)
    await act(async () => {
      render(<NewProject />)
    })
    expect(screen.getByTestId('cap').textContent).toContain('How much may it spend?')
    expect((screen.getByTestId('draft-budget') as HTMLInputElement).value).toBe('15')
    expect((screen.getByTestId('draft-minutes') as HTMLInputElement).value).toBe('90')
    await act(async () => screen.getByTestId('start-building').click())
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/accept'))
    expect(call).toBeDefined()
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as { draft: { budgetUsd: number | null; timeLimitMs: number | null } }
    expect(body.draft).toMatchObject({ budgetUsd: 15, timeLimitMs: 5_400_000 })
    expect(push).toHaveBeenCalledWith('/w/ws-9')
  })

  it('keeps Start building off for No limit until the person says they understand', async () => {
    search = new URLSearchParams('intake=in-1')
    stubFetch(answer)
    await act(async () => {
      render(<NewProject />)
    })
    await act(async () => (screen.getByTestId('cap-none').querySelector('button') as HTMLButtonElement).click())
    expect((screen.getByTestId('start-building') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => screen.getByTestId('cap-none-ok').click())
    expect((screen.getByTestId('start-building') as HTMLButtonElement).disabled).toBe(false)
  })
})
