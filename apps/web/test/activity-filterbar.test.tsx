// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '@ai-team-os/db'
import { useUrlFilters } from '../src/hooks/useUrlFilters.js'
import { FilterBar } from '../src/components/activity/FilterBar.js'

const replace = vi.fn()
let params = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/w/w1/activity',
  useSearchParams: () => params,
}))

beforeEach(() => {
  replace.mockClear()
  params = new URLSearchParams()
})

describe('useUrlFilters', () => {
  it('parses the URL through parseActivityFilters — kinds expand, types union', () => {
    params = new URLSearchParams('agents=a1,a2&kinds=guardrails&types=run.output')
    const { result } = renderHook(() => useUrlFilters())
    expect(result.current.filters.agents).toEqual(['a1', 'a2'])
    expect([...result.current.filters.types].sort()).toEqual([
      'guardrail.tripped',
      'run.output',
      'workspace.goal_set',
      'workspace.plan_created',
    ])
  })

  it('exposes the raw ?kinds= and ?types= selections for chip/popover state', () => {
    params = new URLSearchParams('kinds=guardrails&types=run.output')
    const { result } = renderHook(() => useUrlFilters())
    expect(result.current.kinds).toEqual(['guardrails'])
    expect(result.current.rawTypes).toEqual(['run.output'])
  })

  it('drops unknown kind/type tokens from the raw lists rather than crashing', () => {
    params = new URLSearchParams('kinds=nonsense,guardrails&types=run.exploded,run.output')
    const { result } = renderHook(() => useUrlFilters())
    expect(result.current.kinds).toEqual(['guardrails'])
    expect(result.current.rawTypes).toEqual(['run.output'])
    // the surviving, known tokens still reach `filters` — an unknown token doesn't blank the rest
    expect([...result.current.filters.types].sort()).toEqual([
      'guardrail.tripped',
      'run.output',
      'workspace.goal_set',
      'workspace.plan_created',
    ])
  })

  it('setKinds writes the sorted kinds to the URL via a shallow router.replace', () => {
    const { result } = renderHook(() => useUrlFilters())
    result.current.setKinds(['tasks', 'runs'])
    expect(replace).toHaveBeenCalledWith('/w/w1/activity?kinds=runs%2Ctasks', { scroll: false })
  })

  it('setRawTypes writes ?types=', () => {
    const { result } = renderHook(() => useUrlFilters())
    result.current.setRawTypes(['run.output'])
    expect(replace).toHaveBeenCalledWith('/w/w1/activity?types=run.output', { scroll: false })
  })

  it('setAgents writes sorted ids to ?agents=', () => {
    const { result } = renderHook(() => useUrlFilters())
    result.current.setAgents(['a2', 'a1'])
    expect(replace).toHaveBeenCalledWith('/w/w1/activity?agents=a1%2Ca2', { scroll: false })
  })

  it('setTasks writes sorted ids to ?tasks=, preserving the other dimensions already in the URL', () => {
    params = new URLSearchParams('kinds=guardrails')
    const { result } = renderHook(() => useUrlFilters())
    result.current.setTasks(['t1'])
    expect(replace).toHaveBeenCalledWith('/w/w1/activity?tasks=t1&kinds=guardrails', { scroll: false })
  })

  it('an empty selection clears the URL back to the bare pathname', () => {
    params = new URLSearchParams('kinds=guardrails')
    const { result } = renderHook(() => useUrlFilters())
    result.current.setKinds([])
    expect(replace).toHaveBeenCalledWith('/w/w1/activity', { scroll: false })
  })
})

const agents = [
  { id: 'a1', name: 'Agent One' },
  { id: 'a2', name: 'Agent Two' },
]
const tasks = [{ id: 't1', title: 'Task One' }]

function Harness(): ReactElement {
  const urlFilters = useUrlFilters()
  return <FilterBar agents={agents} tasks={tasks} {...urlFilters} />
}

describe('FilterBar', () => {
  it('renders the five kind chips', () => {
    render(<Harness />)
    expect(screen.getByTestId('kind-chip-runs')).toBeTruthy()
    expect(screen.getByTestId('kind-chip-tool_calls')).toBeTruthy()
    expect(screen.getByTestId('kind-chip-tasks')).toBeTruthy()
    expect(screen.getByTestId('kind-chip-interventions')).toBeTruthy()
    expect(screen.getByTestId('kind-chip-guardrails')).toBeTruthy()
  })

  it('toggling a kind chip updates the URL', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('kind-chip-guardrails'))
    expect(replace).toHaveBeenCalledWith('/w/w1/activity?kinds=guardrails', { scroll: false })
  })

  it('toggling an already-selected chip off clears it from the URL', () => {
    params = new URLSearchParams('kinds=guardrails')
    render(<Harness />)
    const chip = screen.getByTestId('kind-chip-guardrails')
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip)
    expect(replace).toHaveBeenCalledWith('/w/w1/activity', { scroll: false })
  })

  it('the advanced popover lists all 20 domain event types', () => {
    render(<Harness />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).length)
  })

  it('toggling one advanced type checkbox lands in ?types=', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('type-checkbox-run.output'))
    expect(replace).toHaveBeenCalledWith('/w/w1/activity?types=run.output', { scroll: false })
  })

  it('the agent select renders the roster and writes the chosen id on change', () => {
    render(<Harness />)
    const select = screen.getByTestId('select-agents') as HTMLSelectElement
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Agent One',
      'Agent Two',
    ])
    const option = within(select).getByText('Agent Two') as HTMLOptionElement
    option.selected = true
    fireEvent.change(select)
    expect(replace).toHaveBeenCalledWith('/w/w1/activity?agents=a2', { scroll: false })
  })

  it('the task select renders the roster and writes the chosen id on change', () => {
    render(<Harness />)
    const select = screen.getByTestId('select-tasks') as HTMLSelectElement
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Task One'])
    const option = within(select).getByText('Task One') as HTMLOptionElement
    option.selected = true
    fireEvent.change(select)
    expect(replace).toHaveBeenCalledWith('/w/w1/activity?tasks=t1', { scroll: false })
  })
})
