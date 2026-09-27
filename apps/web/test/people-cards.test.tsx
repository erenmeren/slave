// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PeopleCards } from '../src/components/persons/PeopleCards.js'
import type { PeoplePageView, PersonCardRow, SkillCatalogueRow } from '../src/server/persons.js'
import type { CardSkillRow } from '../src/lib/cardSkills.js'

let search = ''
const replaceState = vi.fn()

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
}))

function person(over: Partial<PersonCardRow> = {}): PersonCardRow {
  return {
    personId: 'p1',
    name: 'Atlas',
    personaId: 't1',
    personaName: 'Builder',
    state: 'assigned',
    stateLabel: 'ASSIGNED',
    departments: [],
    seats: [
      { slaveId: 's1', teamId: 'tm1', teamName: 'Engineering', workspaceId: 'w1', projectName: 'Alpha', role: 'dev', runtimeRoles: ['dev'], closedAt: null },
    ],
    skillCount: 0,
    capabilities: [],
    lifecycle: 'permanent',
    releasedAt: null,
    releaseReason: null,
    division: 'engineering',
    skills: [],
    workflowPreview: { steps: [], total: 0 },
    ...over,
  }
}

const pageOf = (rows: readonly PersonCardRow[], over: Partial<PeoplePageView> = {}): PeoplePageView => ({
  rows,
  facets: { domains: [{ domain: 'qa', count: 1 }], divisions: ['engineering'] },
  total: rows.length,
  nextCursor: null,
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  search = ''
  replaceState.mockClear()
  vi.stubGlobal('history', { replaceState })
  fetchMock = vi.fn(async () => new Response(JSON.stringify(pageOf([person()])), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const renderCards = (initial: PeoplePageView, onOpen: (id: string) => void = vi.fn()) =>
  render(<PeopleCards initial={initial} departments={[{ companyTeamId: 'ct1', name: 'Backend' }]} skillCatalogue={[]} taxonomy={[]} onOpen={onOpen} />)

describe('PeopleCards', () => {
  it('is one card per person, with the handles the gates read', () => {
    renderCards(pageOf([person(), person({ personId: 'p2', name: 'Pooled', state: 'pool', stateLabel: 'IN THE POOL', seats: [] })]))
    const seated = screen.getByTestId('person-row-p1')
    expect(seated.getAttribute('data-person-id')).toBe('p1')
    expect(seated.getAttribute('data-person-state')).toBe('assigned')
    expect(seated.getAttribute('data-released')).toBe('false')
    expect(within(seated).getAllByTestId('person-seat-chip').map((chip) => chip.textContent)).toEqual(['Alpha'])
    expect(within(screen.getByTestId('person-row-p2')).getByTestId('person-pool-chip').textContent).toBe('in the pool')
    expect(within(screen.getByTestId('people-rows')).getByTestId('workforce-card-grid')).toBeTruthy()
  })

  it('greys a released person and still opens them', () => {
    const onOpen = vi.fn()
    renderCards(
      pageOf([person({ state: 'released', stateLabel: 'RELEASED', seats: [], releasedAt: '2026-09-20T00:00:00.000Z' })]),
      onOpen,
    )
    const card = screen.getByTestId('person-row-p1')
    expect(card.getAttribute('data-released')).toBe('true')
    expect(card.className).toContain('opacity-60')
    fireEvent.click(within(card).getByTestId('person-open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('p1')
  })

  it('asks the SERVER when a filter moves, with the filter in the query', async () => {
    renderCards(pageOf([person()]))
    await act(async () => {
      fireEvent.click(screen.getByTestId('people-filter-pool'))
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/persons?state=pool')
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce?state=pool')
  })

  // Controller ruling F16: departments are no longer drawn on a card, so the department select is
  // the one place the filter is still exercised -- it must reach the server as `?department=`.
  it('asks the server for one department when the department select moves', async () => {
    renderCards(pageOf([person()]))
    await act(async () => {
      fireEvent.change(screen.getByTestId('people-filter-department'), { target: { value: 'ct1' } })
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/persons?department=ct1')
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce?department=ct1')
  })

  it('opens on "Everyone" when the URL names no segment (F4)', () => {
    renderCards(pageOf([person()]))
    expect(screen.getByTestId('people-filter').getAttribute('data-value')).toBe('all')
    expect(screen.getByTestId('people-filter-all').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('people-filter-all').textContent).toBe('Everyone')
  })

  it('says "showing N of M" and appends the next page on Show more', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(pageOf([person({ personId: 'p101', name: 'Later' })], { total: 101 })), { status: 200 }),
    )
    renderCards(pageOf([person()], { total: 101, nextCursor: 'p1' }))
    expect(screen.getByTestId('people-count').textContent).toBe('showing 1 of 101 slaves')
    await act(async () => {
      fireEvent.click(screen.getByTestId('people-more'))
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/persons?cursor=p1')
    expect(screen.getAllByTestId(/^person-row-/u).map((card) => card.getAttribute('data-person-id'))).toEqual(['p1', 'p101'])
  })

  it('offers Clear filters on an empty filtered answer', async () => {
    search = 'specialty=no-such-domain'
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(pageOf([])), { status: 200 }))
    renderCards(pageOf([]))
    fireEvent.click(screen.getByTestId('people-empty-clear'))
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce')
  })

  it('re-reads when the page hands it a new refresh key (a person changed in the sheet)', async () => {
    const view = render(
      <PeopleCards initial={pageOf([person()])} departments={[]} skillCatalogue={[]} taxonomy={[]} refreshKey={0} onOpen={vi.fn()} />,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => {
      view.rerender(<PeopleCards initial={pageOf([person()])} departments={[]} skillCatalogue={[]} taxonomy={[]} refreshKey={1} onOpen={vi.fn()} />)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/persons')
  })
})

/**
 * Controller ruling F2: a card write, a sheet change and the server re-rendering the page under a
 * new `?slave=` must never reset People to page one. Page one here is a HUNDRED people (the real
 * `PEOPLE_PAGE_SIZE`), so "past row 100" means exactly what it says.
 */
describe('PeopleCards keeps every loaded page (F2)', () => {
  const sql: SkillCatalogueRow = { skillId: 's-sql', name: 'sql', providerName: 'personal', description: 'writes sql', missing: false }
  const sqlChip = (state: CardSkillRow['state']): CardSkillRow => ({
    skillId: 's-sql',
    name: 'sql',
    providerName: 'personal',
    missing: false,
    process: false,
    state,
  })
  const hundred = Array.from({ length: 100 }, (_, index) =>
    person({ personId: `p${String(index + 1)}`, name: `Person ${String(index + 1)}`, personaId: `other-${String(index + 1)}`, personaName: 'Other' }),
  )
  const later = person({ personId: 'p101', name: 'Later' })
  const pageOne = pageOf(hundred, { total: 101, nextCursor: 'p100' })
  const pageTwo = pageOf([later], { total: 101 })

  const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input.toString())

  const renderWithSkills = (initial: PeoplePageView, refreshKey = 0) =>
    render(<PeopleCards initial={initial} departments={[]} skillCatalogue={[sql]} taxonomy={[]} refreshKey={refreshKey} onOpen={vi.fn()} />)

  const loadPageTwo = async (): Promise<void> => {
    await act(async () => {
      fireEvent.click(screen.getByTestId('people-more'))
    })
    await waitFor(() => expect(screen.getByTestId('person-row-p101')).toBeTruthy())
  }

  const addSql = async (card: HTMLElement, everyone = false): Promise<void> => {
    fireEvent.click(within(card).getByTestId('card-skill-add'))
    if (everyone) fireEvent.click(within(card).getByTestId('skill-picker-scope-persona'))
    fireEvent.click(within(card).getByTestId('skill-picker-option-s-sql'))
    await act(async () => {
      fireEvent.click(within(card).getByTestId('skill-picker-confirm'))
    })
  }

  const listReads = (): readonly string[] => fetchMock.mock.calls.map(([input]) => urlOf(input as RequestInfo)).filter((url) => url.startsWith('/api/persons?') || url === '/api/persons')

  it('patches a person-scope write on a card past row 100 in place, keeping it mounted and every page loaded', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url === '/api/persons/p101/skills') return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (url.includes('cursor=')) return new Response(JSON.stringify(pageTwo), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })
    renderWithSkills(pageOne)
    await loadPageTwo()
    const card = screen.getByTestId('person-row-p101')
    const readsBefore = listReads().length

    await addSql(card)

    expect(fetchMock).toHaveBeenCalledWith('/api/persons/p101/skills', expect.objectContaining({ method: 'PATCH' }))
    // The SAME node: patched in place, never unmounted and redrawn.
    expect(screen.getByTestId('person-row-p101')).toBe(card)
    expect(within(card).getByTestId('card-skill-s-sql').getAttribute('data-origin')).toBe('person')
    expect(screen.getAllByTestId(/^person-row-/u)).toHaveLength(101)
    expect(listReads()).toHaveLength(readsBefore)
  })

  it('turns an inherited chip into a struck-through one when "only this person" removes it', async () => {
    const inheriting = person({ personId: 'p101', name: 'Later', skills: [sqlChip('persona')] })
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url === '/api/persons/p101/skills') return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (url.includes('cursor=')) return new Response(JSON.stringify(pageOf([inheriting], { total: 101 })), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })
    renderWithSkills(pageOne)
    await loadPageTwo()
    const card = screen.getByTestId('person-row-p101')

    fireEvent.click(within(card).getByTestId('card-skill-remove-s-sql'))
    await act(async () => {
      fireEvent.click(within(card).getByTestId('card-skill-remove-scope-person'))
    })

    expect(within(card).getByTestId('card-skill-s-sql').getAttribute('data-origin')).toBe('revoked')
    expect(screen.getAllByTestId(/^person-row-/u)).toHaveLength(101)
  })

  it('re-reads the loaded range after a persona-scope write, so the OTHER cards of that persona change too', async () => {
    const sibling = person({ personId: 'p1', name: 'Sibling', personaId: 't1' })
    const first = pageOf([sibling], { total: 2, nextCursor: 'p1' })
    let written = false
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url === '/api/org/templates/t1/skills') {
        written = true
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      const skills = written ? [sqlChip('persona')] : []
      if (url.includes('cursor=')) return new Response(JSON.stringify(pageOf([{ ...later, skills }], { total: 2 })), { status: 200 })
      if (url === '/api/persons') return new Response(JSON.stringify(pageOf([{ ...sibling, skills }], { total: 2, nextCursor: 'p1' })), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })
    renderWithSkills(first)
    await loadPageTwo()

    await addSql(screen.getByTestId('person-row-p101'), true)

    await waitFor(() =>
      expect(within(screen.getByTestId('person-row-p1')).getByTestId('card-skill-s-sql').getAttribute('data-origin')).toBe('persona'),
    )
    expect(screen.getAllByTestId(/^person-row-/u).map((card) => card.getAttribute('data-person-id'))).toEqual(['p1', 'p101'])
    expect(within(screen.getByTestId('person-row-p101')).getByTestId('card-skill-s-sql')).toBeTruthy()
  })

  it('keeps both pages when the server hands a new page one (a ?slave= change re-rendered the page)', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.includes('cursor=')) return new Response(JSON.stringify(pageTwo), { status: 200 })
      if (url === '/api/persons') return new Response(JSON.stringify(pageOne), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })
    const view = renderWithSkills(pageOne)
    await loadPageTwo()
    const card = screen.getByTestId('person-row-p101')

    await act(async () => {
      // A NEW object with the same answer -- what a `router.replace` to `?slave=p101` hands down.
      view.rerender(
        <PeopleCards initial={{ ...pageOne, rows: [...pageOne.rows] }} departments={[]} skillCatalogue={[sql]} taxonomy={[]} onOpen={vi.fn()} />,
      )
    })

    await waitFor(() => expect(screen.getAllByTestId(/^person-row-/u)).toHaveLength(101))
    expect(screen.getByTestId('person-row-p101')).toBe(card)
  })

  it('re-reads page one when the server hands a new one after a new slave, and shows the new hire', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(pageOf([person(), person({ personId: 'p2', name: 'New hire' })])), { status: 200 }),
    )
    const view = renderWithSkills(pageOf([person()]))
    await act(async () => {
      view.rerender(
        <PeopleCards initial={pageOf([person(), person({ personId: 'p2', name: 'New hire' })])} departments={[]} skillCatalogue={[sql]} taxonomy={[]} onOpen={vi.fn()} />,
      )
    })
    await waitFor(() => expect(screen.getByTestId('person-row-p2')).toBeTruthy())
    expect(listReads()).toEqual(['/api/persons'])
  })

  // Task 9 fix round 1: an RSC payload is rendered for the URL at navigation START, so a sheet
  // close followed by a search can deliver an UNFILTERED page one after the search's own answer.
  it('keeps the filtered cards when a new server page one arrives without the filter', async () => {
    const pooled = person({ personId: 'p9', name: 'Pooled', state: 'pool', stateLabel: 'IN THE POOL', seats: [] })
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url === '/api/persons?state=pool') return new Response(JSON.stringify(pageOf([pooled])), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })
    const unfiltered = pageOf([person(), person({ personId: 'p2', name: 'Other' })])
    const view = renderWithSkills(unfiltered)
    await act(async () => {
      fireEvent.click(screen.getByTestId('people-filter-pool'))
    })
    await waitFor(() => expect(screen.getAllByTestId(/^person-row-/u).map((card) => card.getAttribute('data-person-id'))).toEqual(['p9']))

    await act(async () => {
      view.rerender(<PeopleCards initial={{ ...unfiltered }} departments={[]} skillCatalogue={[sql]} taxonomy={[]} onOpen={vi.fn()} />)
    })

    await waitFor(() => expect(listReads().filter((url) => url === '/api/persons?state=pool')).toHaveLength(2))
    expect(screen.getAllByTestId(/^person-row-/u).map((card) => card.getAttribute('data-person-id'))).toEqual(['p9'])
  })

  it('re-reads the loaded range, not page one, when the sheet changes somebody', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.includes('cursor=')) return new Response(JSON.stringify(pageTwo), { status: 200 })
      if (url === '/api/persons') return new Response(JSON.stringify(pageOne), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })
    const view = renderWithSkills(pageOne, 0)
    await loadPageTwo()
    await act(async () => {
      view.rerender(<PeopleCards initial={pageOne} departments={[]} skillCatalogue={[sql]} taxonomy={[]} refreshKey={1} onOpen={vi.fn()} />)
    })
    await waitFor(() => expect(listReads().filter((url) => url === '/api/persons')).toHaveLength(1))
    await waitFor(() => expect(listReads().filter((url) => url.includes('cursor='))).toHaveLength(2))
    expect(screen.getAllByTestId(/^person-row-/u)).toHaveLength(101)
  })

  it('shows people-stale and keeps every loaded page when a refusal’s resync fails, with no unhandled rejection', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url === '/api/persons/p101/skills') return new Response(JSON.stringify({ error: 'the skill sql is missing from disk' }), { status: 409 })
      if (url.includes('cursor=')) return new Response(JSON.stringify(pageTwo), { status: 200 })
      throw new Error('network down')
    })
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      renderWithSkills(pageOne)
      await loadPageTwo()
      await addSql(screen.getByTestId('person-row-p101'))

      await waitFor(() => expect(screen.getByTestId('people-stale')).toBeTruthy())
      expect(screen.getAllByTestId(/^person-row-/u)).toHaveLength(101)
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

/**
 * Final review, finding 4: re-granting a skill this person REVOKED is a restore -- the persona
 * speaks again -- never a grant of their own. The picker offers the struck skill; choosing it must
 * send the restore's `clear`, and the chip must come back inherited, so its × then asks the
 * inherited question (revoke) rather than clearing a grant that does not exist.
 */
describe('re-granting a revoked skill restores it (final review, finding 4)', () => {
  const sql: SkillCatalogueRow = { skillId: 's-sql', name: 'sql', providerName: 'personal', description: 'writes sql', missing: false }
  const struck: CardSkillRow = { skillId: 's-sql', name: 'sql', providerName: 'personal', missing: false, process: false, state: 'revoked' }

  it.each(['person', 'persona'] as const)('restores through the picker with scope %s, and × then revokes again', async (scope) => {
    const bodies: unknown[] = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/skills')) {
        bodies.push({ url, body: JSON.parse(String(init?.body)) as unknown })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify(pageOf([person({ skills: [{ ...struck, state: 'persona' }] })])), { status: 200 })
    })
    render(<PeopleCards initial={pageOf([person({ skills: [struck] })])} departments={[]} skillCatalogue={[sql]} taxonomy={[]} onOpen={vi.fn()} />)
    const card = screen.getByTestId('person-row-p1')

    fireEvent.click(within(card).getByTestId('card-skill-add'))
    if (scope === 'persona') fireEvent.click(within(card).getByTestId('skill-picker-scope-persona'))
    fireEvent.click(within(card).getByTestId('skill-picker-option-s-sql'))
    await act(async () => {
      fireEvent.click(within(card).getByTestId('skill-picker-confirm'))
    })

    expect(bodies).toEqual([{ url: '/api/persons/p1/skills', body: { clear: ['s-sql'] } }])
    await waitFor(() => expect(within(card).getByTestId('card-skill-s-sql').getAttribute('data-origin')).toBe('persona'))

    fireEvent.click(within(card).getByTestId('card-skill-remove-s-sql'))
    await act(async () => {
      fireEvent.click(within(card).getByTestId('card-skill-remove-scope-person'))
    })
    expect(bodies.at(-1)).toEqual({ url: '/api/persons/p1/skills', body: { revoke: ['s-sql'] } })
  })
})
