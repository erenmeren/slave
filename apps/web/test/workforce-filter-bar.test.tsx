// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityDomainFacet } from '@slave-of-ai/control'
import { WorkforceFilterBar } from '../src/components/workforce/WorkforceFilterBar.js'
import { usePeopleFilters } from '../src/hooks/usePeopleFilters.js'
import { CATALOG_SEARCH_DEBOUNCE_MS } from '../src/lib/catalogFilters.js'
import { withPeopleFilter } from '../src/lib/peopleFilters.js'

let search = ''
const replaceState = vi.fn()

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
}))

beforeEach(() => {
  search = ''
  replaceState.mockClear()
  vi.stubGlobal('history', { replaceState })
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

/** Ten domains, busiest first -- the order the server hands them in. */
const DOMAINS: readonly CapabilityDomainFacet[] = [
  'frontend', 'backend', 'qa', 'docs', 'design', 'data', 'devops', 'security', 'ai', 'mobile',
].map((domain, index) => ({ domain, count: 10 - index }))

type BarProps = React.ComponentProps<typeof WorkforceFilterBar>

function renderBar(over: Partial<BarProps> = {}): { props: BarProps; rerender: (next: Partial<BarProps>) => void } {
  const props: BarProps = {
    testIdPrefix: 'people',
    query: '',
    onQuery: vi.fn(),
    domains: DOMAINS,
    specialty: undefined,
    onSpecialty: vi.fn(),
    divisions: ['engineering'],
    division: undefined,
    onDivision: vi.fn(),
    skillOptions: [{ value: 's1', label: 'pdf (personal)' }],
    skill: undefined,
    onSkill: vi.fn(),
    noSkills: false,
    onNoSkills: vi.fn(),
    filtered: false,
    onClear: vi.fn(),
    searchPlaceholder: 'name, persona, capability, skill',
    ...over,
  }
  const view = render(<WorkforceFilterBar {...props} />)
  return { props, rerender: (next) => view.rerender(<WorkforceFilterBar {...props} {...next} />) }
}

const chipIds = (): string[] =>
  screen.getAllByTestId(/^people-specialty-(?!more$)/u).map((chip) => chip.getAttribute('data-testid') ?? '')

describe('WorkforceFilterBar', () => {
  it('shows the eight busiest specialties with their counts, the rest behind +N', () => {
    renderBar()
    expect(chipIds()).toHaveLength(8)
    expect(screen.getByTestId('people-specialty-frontend').textContent).toBe('Frontend10')
    expect(screen.getByTestId('people-specialty-qa').textContent).toBe('QA8')
    expect(screen.getByTestId('people-specialty-more').textContent).toBe('+2')
    fireEvent.click(screen.getByTestId('people-specialty-more'))
    expect(chipIds()).toHaveLength(10)
  })

  it('a chip chooses its specialty, and the pressed chip clears it', () => {
    const { props, rerender } = renderBar()
    fireEvent.click(screen.getByTestId('people-specialty-qa'))
    expect(props.onSpecialty).toHaveBeenLastCalledWith('qa')
    rerender({ specialty: 'qa' })
    expect(screen.getByTestId('people-specialty-qa').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('people-specialty-qa'))
    expect(props.onSpecialty).toHaveBeenLastCalledWith('')
  })

  it('keeps a specialty chosen from the folded tail visible after the fold closes', () => {
    renderBar({ specialty: 'mobile' })
    expect(screen.getByTestId('people-specialty-mobile').getAttribute('aria-pressed')).toBe('true')
  })

  it('shows an unknown specialty from a stale link as a pressed chip with 0, so it can be cleared', () => {
    renderBar({ specialty: 'no-such-domain', filtered: true })
    const chip = screen.getByTestId('people-specialty-no-such-domain')
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.getAttribute('data-count')).toBe('0')
    expect(screen.getByTestId('people-clear-filters')).toBeTruthy()
  })

  it('toggles "No skills"', () => {
    const { props, rerender } = renderBar()
    fireEvent.click(screen.getByTestId('people-no-skills'))
    expect(props.onNoSkills).toHaveBeenLastCalledWith(true)
    rerender({ noSkills: true })
    expect(screen.getByTestId('people-no-skills').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('people-no-skills'))
    expect(props.onNoSkills).toHaveBeenLastCalledWith(false)
  })

  it('asks for a search only after the debounce', async () => {
    const { props } = renderBar()
    fireEvent.change(screen.getByTestId('people-search'), { target: { value: 'atl' } })
    expect(props.onQuery).not.toHaveBeenCalled()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CATALOG_SEARCH_DEBOUNCE_MS + 20))
    })
    expect(props.onQuery).toHaveBeenLastCalledWith('atl')
  })

  it('offers the division and the skill as selects', () => {
    const { props } = renderBar()
    fireEvent.change(screen.getByTestId('people-division-select'), { target: { value: 'engineering' } })
    expect(props.onDivision).toHaveBeenLastCalledWith('engineering')
    fireEvent.change(screen.getByTestId('people-skill-select'), { target: { value: 's1' } })
    expect(props.onSkill).toHaveBeenLastCalledWith('s1')
  })
})

/** The bar wired to People's own URL hook, exactly as `PeopleCards` wires it (Task 9). */
function Harness(): React.JSX.Element {
  const { filters, setFilters } = usePeopleFilters()
  return (
    <WorkforceFilterBar
      testIdPrefix="people"
      query={filters.q ?? ''}
      onQuery={(value) => setFilters(withPeopleFilter(filters, 'q', value))}
      domains={DOMAINS}
      specialty={filters.specialty}
      onSpecialty={(value) => setFilters(withPeopleFilter(filters, 'specialty', value))}
      divisions={[]}
      division={filters.division}
      onDivision={(value) => setFilters(withPeopleFilter(filters, 'division', value))}
      skillOptions={[]}
      skill={filters.skillId}
      onSkill={(value) => setFilters(withPeopleFilter(filters, 'skillId', value))}
      noSkills={filters.noSkills === true}
      onNoSkills={(next) => setFilters(withPeopleFilter(filters, 'noSkills', next ? 'true' : ''))}
      filtered={Object.keys(filters).length > 0}
      onClear={() => setFilters({})}
      searchPlaceholder="name"
    />
  )
}

describe('the filter URL', () => {
  it('is read on arrival and written back MERGED with the params it does not own', () => {
    // The real jsdom history puts the URL in place; the stub then records what the hook writes.
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/workforce?tab=slaves&specialty=qa')
    vi.stubGlobal('history', { replaceState })
    search = 'tab=slaves&specialty=qa'

    render(<Harness />)
    expect(screen.getByTestId('people-specialty-qa').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('people-no-skills'))
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce?tab=slaves&specialty=qa&skills=none')
    fireEvent.click(screen.getByTestId('people-clear-filters'))
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce?tab=slaves')
  })
})
