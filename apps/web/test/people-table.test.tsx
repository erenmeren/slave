// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { PeopleTable } from '../src/components/persons/PeopleTable.js'
import type { PersonRow } from '../src/server/persons.js'

/**
 * `PeopleTable`'s `DataTable` is virtualized now (M61 Task 9): `@tanstack/react-virtual`
 * measures its scroll viewport via `offsetWidth`/`offsetHeight` when no `ResizeObserver` is
 * present -- jsdom has none by default -- the same jsdom measurement idiom
 * `test/activity-page.test.tsx`'s own `mockElementSizes` uses for `Timeline`'s virtualizer.
 * Without it every case below (a handful of fixture rows apiece) would find none rendered at
 * all, since jsdom's unmeasured viewport is 0px tall. Generous by default -- large enough that
 * every fixture in this file's ORIGINAL cases (three rows, never more) renders in full; the
 * dedicated 500-row case below overrides it with a real 400px bound to prove virtualization
 * actually narrows what mounts.
 */
function mockElementSizes(height: number): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: height })
}

beforeEach(() => {
  mockElementSizes(2000)
})

const pooled: PersonRow = {
  personId: 'p-pool', name: 'Pooled', personaId: 't1', personaName: 'Builder',
  state: 'pool', stateLabel: 'IN THE POOL', departments: [], seats: [],
  skillCount: 0, capabilities: [], lifecycle: 'project', releasedAt: null, releaseReason: null,
}

const assigned: PersonRow = {
  personId: 'p-two', name: 'Atlas', personaId: 't1', personaName: 'Builder',
  state: 'assigned', stateLabel: 'ASSIGNED',
  departments: [{ companyTeamId: 'ct1', name: 'Engineering' }],
  seats: [
    { slaveId: 's1', teamId: 'tm1', teamName: 'Engineering', workspaceId: 'w1', projectName: 'Alpha', role: 'dev', runtimeRoles: ['dev'], closedAt: null },
    { slaveId: 's2', teamId: 'tm2', teamName: 'Engineering', workspaceId: 'w2', projectName: 'Beta', role: 'dev', runtimeRoles: ['dev'], closedAt: null },
  ],
  skillCount: 3, capabilities: ['backend'], lifecycle: 'permanent', releasedAt: null, releaseReason: null,
}

const released: PersonRow = {
  personId: 'p-gone', name: 'Gone', personaId: null, personaName: null,
  state: 'released', stateLabel: 'RELEASED', departments: [], seats: [],
  skillCount: 1, capabilities: [], lifecycle: 'ephemeral',
  releasedAt: '2026-09-15T00:00:00.000Z', releaseReason: 'the engagement is over',
}

const rows = [assigned, pooled, released]

describe('PeopleTable', () => {
  it('is one row per person, with the persona, the departments and the skill count', () => {
    render(<PeopleTable initial={rows} departments={[{ companyTeamId: 'ct1', name: 'Engineering' }]} skills={[]} onOpen={() => {}} />)
    const row = screen.getByTestId('person-row-p-two')
    expect(within(row).getByTestId('person-name').textContent).toBe('Atlas')
    expect(within(row).getByTestId('person-persona').textContent).toBe('Builder')
    expect(within(row).getByTestId('person-departments').textContent).toBe('Engineering')
    expect(within(row).getByTestId('person-skill-count').textContent).toBe('3')
  })

  it('shows one chip per seat, naming the project', () => {
    render(<PeopleTable initial={rows} departments={[]} skills={[]} onOpen={() => {}} />)
    const chips = within(screen.getByTestId('person-row-p-two')).getAllByTestId('person-seat-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual(['Alpha', 'Beta'])
  })

  it('says “in the pool” for somebody with no seat, and never prints the raw state as text', () => {
    render(<PeopleTable initial={rows} departments={[]} skills={[]} onOpen={() => {}} />)
    const row = screen.getByTestId('person-row-p-pool')
    expect(within(row).getByTestId('person-pool-chip').textContent).toMatch(/in the pool/i)
    expect(row.getAttribute('data-person-state')).toBe('pool')
    expect(row.textContent).not.toContain('pool ')
  })

  it('the three filters narrow the list', () => {
    render(<PeopleTable initial={rows} departments={[]} skills={[]} onOpen={() => {}} />)
    expect(screen.getAllByTestId(/^person-row-/)).toHaveLength(3)

    fireEvent.click(screen.getByTestId('people-filter-pool'))
    expect(screen.getAllByTestId(/^person-row-/).map((row) => row.getAttribute('data-person-id'))).toEqual(['p-pool'])

    fireEvent.click(screen.getByTestId('people-filter-assigned'))
    expect(screen.getAllByTestId(/^person-row-/).map((row) => row.getAttribute('data-person-id'))).toEqual(['p-two'])

    fireEvent.click(screen.getByTestId('people-filter-released'))
    expect(screen.getAllByTestId(/^person-row-/).map((row) => row.getAttribute('data-person-id'))).toEqual(['p-gone'])
  })

  it('filters by department and by skill', () => {
    const withSkill: PersonRow = { ...pooled, personId: 'p-skilled', name: 'Skilled', skillCount: 1 }
    render(
      <PeopleTable
        initial={[assigned, withSkill]}
        departments={[{ companyTeamId: 'ct1', name: 'Engineering' }]}
        skills={[{ skillId: 'sk1', name: 'pdf', providerName: 'personal' }]}
        skillHolders={{ sk1: ['p-skilled'] }}
        onOpen={() => {}}
      />,
    )
    fireEvent.change(screen.getByTestId('people-filter-department'), { target: { value: 'ct1' } })
    expect(screen.getAllByTestId(/^person-row-/).map((row) => row.getAttribute('data-person-id'))).toEqual(['p-two'])

    fireEvent.change(screen.getByTestId('people-filter-department'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('people-filter-skill'), { target: { value: 'sk1' } })
    expect(screen.getAllByTestId(/^person-row-/).map((row) => row.getAttribute('data-person-id'))).toEqual(['p-skilled'])
  })

  it('the ⋯ opens the person', () => {
    const opened: string[] = []
    render(<PeopleTable initial={rows} departments={[]} skills={[]} onOpen={(id) => opened.push(id)} />)
    fireEvent.click(within(screen.getByTestId('person-row-p-two')).getByTestId('person-open'))
    expect(opened).toEqual(['p-two'])
  })
})

function personRow(index: number): PersonRow {
  return {
    personId: `p${String(index)}`,
    name: `Person ${String(index)}`,
    personaId: null,
    personaName: null,
    state: 'pool',
    stateLabel: 'IN THE POOL',
    departments: [],
    seats: [],
    skillCount: 0,
    capabilities: [],
    lifecycle: 'project',
    releasedAt: null,
    releaseReason: null,
  }
}

describe('PeopleTable (M61 Task 9: virtualized)', () => {
  it('carries a people-table handle on its root', () => {
    render(<PeopleTable initial={rows} departments={[]} skills={[]} onOpen={() => {}} />)
    expect(screen.getByTestId('people-table')).toBeTruthy()
  })

  it('renders 500 rows inside a 400px-tall scroll element without mounting all of them', () => {
    mockElementSizes(400)
    const fiveHundred = Array.from({ length: 500 }, (_, index) => personRow(index))
    render(<PeopleTable initial={fiveHundred} departments={[]} skills={[]} skillHolders={{}} onOpen={() => {}} />)

    // jsdom's virtualizer measurement is a fallback (no real layout engine), so this stays a
    // range rather than an exact count -- the CLAIM is "virtualized", not "exactly N rows".
    const rendered = document.querySelectorAll('[data-testid^="person-row-"]').length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(60)
  })
})
