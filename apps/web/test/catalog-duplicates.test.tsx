// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogRowView, TemplateDuplicateRowView, WorkforceCatalogView } from '../src/server/org.js'
import { ProfileDrawer } from '../src/components/workforce/ProfileDrawer.js'
import { WorkforceCatalog } from '../src/components/workforce/WorkforceCatalog.js'

const replaceState = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))

function row(over: Partial<CatalogRowView> = {}): CatalogRowView {
  return {
    id: 't1',
    name: 'Core Builder',
    role: 'engineering',
    description: 'Builds the core.',
    defaultModel: null,
    defaultProvider: null,
    catalogSlaveCount: 0,
    sourceId: 'catalog-m55/engineering/core-builder',
    sourceDivision: 'engineering',
    importedAt: '2026-09-14T09:00:00.000Z',
    sourceRepository: 'catalog-m55',
    sourceRevision: '0f1e2d3',
    sourceLicense: 'MIT',
    source: 'imported',
    structured: true,
    summary: 'Builds the core module and the tests that hold it up.',
    capabilities: ['Design the module boundary'],
    capabilityKeys: ['backend.services'],
    expertise: ['Load-bearing code'],
    recommendedSkills: ['writing-plans'],
    mappingQuality: 'full',
    overriddenFields: [],
    rawOverride: false,
    active: false,
    activationChangedAt: null,
    activationChangedBy: null,
    duplicate: null,
    duplicateCount: 0,
    ...over,
  }
}

const view = (rows: readonly CatalogRowView[], over: Partial<WorkforceCatalogView> = {}): WorkforceCatalogView => ({
  rows,
  facets: { divisions: ['engineering'], capabilities: ['backend.services'], skills: ['writing-plans'] },
  total: rows.length,
  nextCursor: null,
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('history', { replaceState })
  fetchMock = vi.fn(async () => new Response(JSON.stringify(view([row()])), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the activation toggle (M55 R2, R6)', () => {
  it('reads a WORD and carries the boolean one attribute away (ia.md rule 3)', () => {
    render(<WorkforceCatalog initial={view([row({ active: false })])} />)

    const toggle = screen.getByTestId('catalog-activate-t1')
    expect(toggle.textContent).toBe('inactive')
    expect(toggle.getAttribute('data-active')).toBe('false')
    expect(screen.getByTestId('catalog-row-t1').textContent).not.toContain('false')
  })

  it('reads the other word for a row that is on', () => {
    render(<WorkforceCatalog initial={view([row({ active: true })])} />)

    expect(screen.getByTestId('catalog-activate-t1').textContent).toBe('active')
    expect(screen.getByTestId('catalog-activate-t1').getAttribute('data-active')).toBe('true')
  })

  it('posts the OPPOSITE of what the row says, to the row own activation path', async () => {
    render(<WorkforceCatalog initial={view([row({ active: false })])} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-activate-t1'))
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/templates/t1/activation',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ active: true }) }),
      )
    })
  })

  // Fix round 1, item 3: a refused write used to change nothing and say nothing, which is exactly
  // what a click that never registered looks like.
  it('says what a refused activation said, in the refusal own words', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/activation')
        ? new Response(JSON.stringify({ error: 'no template with id t1' }), { status: 404 })
        : new Response(JSON.stringify(view([row()])), { status: 200 }),
    )
    render(<WorkforceCatalog initial={view([row({ active: false })])} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-activate-t1'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('catalog-error').textContent).toBe('no template with id t1')
    })
    // The word on the row is still the truth: it is only re-read on success.
    expect(screen.getByTestId('catalog-activate-t1').textContent).toBe('inactive')
  })

  it('does NOT open the drawer -- the toggle is an action ON the row, not a way INTO it', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-activate-t1'))
    })

    expect(screen.queryByTestId('profile-drawer')).toBeNull()
  })
})

describe('the duplicate chip (M55 R6, R9)', () => {
  const withPair = (over: Partial<CatalogRowView> = {}): CatalogRowView =>
    row({
      duplicate: {
        pairId: 'p1',
        class: 'exact',
        basis: 'content_hash',
        score: 1,
        otherTemplateId: 't2',
        otherName: 'Backend Architect',
      },
      duplicateCount: 1,
      ...over,
    })

  it('reads as a sentence: the class as words, then the OTHER row name', () => {
    render(<WorkforceCatalog initial={view([withPair()])} />)

    expect(screen.getByTestId('catalog-duplicate-t1').textContent).toContain('Duplicate of Backend Architect')
  })

  it('says `+N` when the row is in more than one pair', () => {
    render(<WorkforceCatalog initial={view([withPair({ duplicateCount: 3 })])} />)

    expect(screen.getByTestId('catalog-duplicate-t1').textContent).toContain('+2')
  })

  it('carries the raw class, the raw basis and the score on attributes, and prints none of them', () => {
    render(<WorkforceCatalog initial={view([withPair()])} />)

    const chip = screen.getByTestId('catalog-duplicate-t1')
    expect(chip.getAttribute('data-class')).toBe('exact')
    expect(chip.getAttribute('data-basis')).toBe('content_hash')
    expect(chip.getAttribute('data-score')).toBe('1')
    expect(chip.textContent).not.toContain('exact')
    expect(chip.textContent).not.toContain('content_hash')
  })

  it('puts the basis, the score to three decimals and the evidence sentence in the title (R9)', () => {
    render(<WorkforceCatalog initial={view([withPair()])} />)

    const title = screen.getByTestId('catalog-duplicate-t1').getAttribute('title') ?? ''
    expect(title).toContain('same persona text')
    expect(title).toContain('1.000')
    expect(title).toContain('evidence is recorded per profile, so two rows split their own record')
  })

  it('renders NO chip for a row nothing was noticed about', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    expect(screen.queryByTestId('catalog-duplicate-t1')).toBeNull()
  })
})

describe('the count sentence and Show more (M55 R3)', () => {
  it('says `N templates` when the page IS the whole answer', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    expect(screen.getByTestId('catalog-count').textContent).toBe('1 template')
    expect(screen.queryByTestId('catalog-more')).toBeNull()
  })

  it('says `showing N of M templates` when it is not, and offers the control', () => {
    render(<WorkforceCatalog initial={view([row()], { total: 312, nextCursor: 't1' })} />)

    expect(screen.getByTestId('catalog-count').textContent).toBe('showing 1 of 312 templates')
    expect(screen.getByTestId('catalog-more')).toBeTruthy()
  })

  it('asks for the NEXT page with the cursor, and APPENDS rather than replacing', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(view([row({ id: 't2', name: 'Second Row' })], { total: 2, nextCursor: null })), {
          status: 200,
        }),
    )
    render(<WorkforceCatalog initial={view([row()], { total: 2, nextCursor: 't1' })} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-more'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('catalog-row-t1')).toBeTruthy()
      expect(screen.getByTestId('catalog-row-t2')).toBeTruthy()
    })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=t1'))).toBe(true)
    expect(screen.getByTestId('catalog-count').textContent).toBe('2 templates')
  })
})

describe('the two new filter controls (M55 R3, R6)', () => {
  it('offers the duplicate facets as WORDS over raw values', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    const select = screen.getByTestId('catalog-duplicates-select') as HTMLSelectElement
    const options = [...select.options].map((option) => [option.value, option.text] as const)
    expect(options).toEqual([
      ['', 'any'],
      ['exact', 'duplicates'],
      ['near', 'near duplicates'],
      ['overlapping', 'overlapping capabilities'],
      ['none', 'no signal'],
    ])
  })

  it('offers the capability facet as LABELS over taxonomy keys', () => {
    render(
      <WorkforceCatalog
        initial={view([row()])}
        taxonomy={[
          { key: 'backend.services', label: 'Service implementation', domain: 'backend', role: 'backend', synonyms: [] },
        ]}
      />,
    )

    const select = screen.getByTestId('catalog-capability-select') as HTMLSelectElement
    const option = [...select.options].find((candidate) => candidate.value === 'backend.services')
    expect(option?.text).toBe('Service implementation')
  })

  it('falls back to the KEY for a facet value this build taxonomy has never heard of', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    const select = screen.getByTestId('catalog-capability-select') as HTMLSelectElement
    expect([...select.options].find((candidate) => candidate.value === 'backend.services')?.text).toBe(
      'backend.services',
    )
  })

  it('has an activation chip per word, pressed state and all', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    expect(screen.getByTestId('catalog-active-chip-active').textContent).toBe('active')
    expect(screen.getByTestId('catalog-active-chip-inactive').textContent).toBe('inactive')
    expect(screen.getByTestId('catalog-active-chip-active').getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-active-chip-active'))
    })

    expect(screen.getByTestId('catalog-active-chip-active').getAttribute('aria-pressed')).toBe('true')
  })

  /**
   * Final wave, minor 7. `data-active` meant two things on one page -- a template's own boolean on
   * the row's toggle, and which chip a filter is -- so `[data-active="true"]` matched both and a
   * gate written against either would have been measuring the other half the time. The chip carries
   * the WORD on `data-activation` now, the way its `data-source` sibling does.
   */
  it('leaves `data-active` to the ROW: the filter chip carries its word on `data-activation`', () => {
    render(<WorkforceCatalog initial={view([row({ active: true })])} />)

    const chip = screen.getByTestId('catalog-active-chip-active')
    expect(chip.getAttribute('data-activation')).toBe('active')
    expect(chip.hasAttribute('data-active')).toBe(false)

    // One page, one meaning: the only `data-active` on it is the row's own state.
    const bothMeanings = document.querySelectorAll('[data-active]')
    expect([...bothMeanings].map((node) => node.getAttribute('data-testid'))).toEqual(['catalog-activate-t1'])
  })
})

/**
 * The fourteenth group (M55 R6): the row is a SIGNAL -- one chip, the strongest undismissed pair --
 * and the drawer is the RECORD, every pair this row is in, dismissed ones included.
 */
describe('the profile drawer Duplicates group (M55 R6)', () => {
  const spec = {
    identity: 'The slave that lays the load-bearing parts first.',
    summary: 'Builds the core module.',
    mission: 'Put the load-bearing parts in first.',
    runtimeRole: 'engineering',
    capabilities: ['Design the module boundary'],
    expertise: ['Load-bearing code'],
    operatingPrinciples: ['Small commits, each one green'],
    constraints: ['You MUST never leave a red test behind'],
    workflow: ['Step 1: read the brief back'],
    deliverables: ['A module and its tests'],
    successCriteria: ['Every commit green'],
    collaborationHints: ['Hand off to the Gate Verifier'],
    recommendedSkills: ['writing-plans'],
    body: 'You write the module everything else stands on.',
    source: null,
  }
  const profile = {
    templateId: 't1',
    name: 'Core Builder',
    upstream: spec,
    overrides: {},
    effective: spec,
    markdown: '## Who you are',
    rawOverride: false,
    overridden: [] as readonly string[],
  }

  const pair = (over: Partial<TemplateDuplicateRowView> = {}): TemplateDuplicateRowView => ({
    id: 'p1',
    class: 'exact',
    basis: 'content_hash',
    score: 1,
    detectedAt: '2026-09-14T09:00:00.000Z',
    dismissedAt: null,
    dismissedBy: null,
    aId: 't1',
    aName: 'Core Builder',
    bId: 't2',
    bName: 'Backend Architect',
    ...over,
  })

  const openDrawer = async (
    pairs: unknown = [pair()],
    props: { readonly onOpenTemplate?: (templateId: string, name: string) => void } = {},
  ): Promise<void> => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/duplicates')
        ? new Response(JSON.stringify(pairs), { status: 200 })
        : new Response(JSON.stringify(profile), { status: 200 }),
    )
    render(
      <ProfileDrawer
        templateId="t1"
        name="Core Builder"
        capabilityKeys={[]}
        taxonomy={[]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        {...props}
      />,
    )
    // Settled means the group is on screen AND it is no longer reading: the pairs are a second
    // fetch behind the profile, so waiting for the drawer alone would read an empty group.
    await waitFor(() => {
      expect(within(duplicatesGroup()).queryByTestId('profile-duplicates-loading')).toBeNull()
    })
  }

  /** The fourteenth `DetailsGroup`, by the `data-group` every other group is found by -- no testid
   *  of its own, because one element carries one `data-testid` and `details-group` is already it. */
  const duplicatesGroup = (): HTMLElement => {
    const group = screen.getAllByTestId('details-group').find((node) => node.getAttribute('data-group') === 'duplicates')
    if (group === undefined) throw new Error('the drawer has no duplicates group')
    return group
  }

  it('names the group after Source, and reads each pair as words', async () => {
    await openDrawer()

    const groups = screen.getAllByTestId('details-group').map((node) => node.getAttribute('data-group'))
    expect(groups).toEqual([
      'identity',
      'mission',
      'capabilities',
      'expertise',
      'principles',
      'constraints',
      'workflow',
      'deliverables',
      'success',
      'collaboration',
      'skills',
      'source',
      'duplicates',
      'body',
      'advanced',
    ])
    const line = screen.getByTestId('profile-duplicate-p1')
    expect(line.textContent).toContain('Duplicate of')
    expect(line.textContent).toContain('Backend Architect')
    expect(line.textContent).toContain('1.000')
    expect(line.textContent).toContain('same persona text')
    expect(line.textContent).toContain('2026-09-14')
    expect(line.getAttribute('data-class')).toBe('exact')
    expect(line.getAttribute('data-basis')).toBe('content_hash')
    expect(line.getAttribute('data-score')).toBe('1')
    expect(line.textContent).not.toContain('content_hash')
  })

  it('names the OTHER template whichever half of the pair this row is', async () => {
    await openDrawer([pair({ aId: 't2', aName: 'Backend Architect', bId: 't1', bName: 'Core Builder' })])

    const line = screen.getByTestId('profile-duplicate-p1')
    expect(line.textContent).toContain('Backend Architect')
    expect(within(line).queryByText('Core Builder')).toBeNull()
  })

  /**
   * Final wave, minor 12. The pair arrives as JSON, so the class and the basis on it are whatever
   * the SERVER knows -- and a browser still holding this bundle after a deploy that added a fourth
   * class indexed the label table with it and rendered `undefined` beside a template's name.
   */
  it('says a word for a class this bundle does not know, and never prints `undefined`', async () => {
    await openDrawer([{ ...pair(), class: 'transposed', basis: 'embedding' }])

    const line = screen.getByTestId('profile-duplicate-p1')
    expect(line.textContent).not.toContain('undefined')
    expect(line.textContent).toContain('Backend Architect')
    // The raw members stay where they always were -- on the attributes, never in the sentence.
    expect(line.getAttribute('data-class')).toBe('transposed')
    expect(line.textContent).not.toContain('transposed')
    expect(line.textContent).not.toContain('embedding')
  })

  it('dismisses a pair through the pair own id, and never deletes anything', async () => {
    await openDrawer()

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-duplicate-dismiss-p1'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/duplicates/p1/dismissal',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ dismissed: true }) }),
    )
    expect(fetchMock.mock.calls.some(([, options]) => (options as { method?: string } | undefined)?.method === 'DELETE')).toBe(
      false,
    )
  })

  it('offers Restore on a dismissed pair, and posts the way back', async () => {
    await openDrawer([pair({ dismissedAt: '2026-09-14T10:00:00.000Z', dismissedBy: 'ada' })])

    expect(screen.getByTestId('profile-duplicate-dismiss-p1').textContent).toBe('Restore')

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-duplicate-dismiss-p1'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/duplicates/p1/dismissal',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ dismissed: false }) }),
    )
  })

  // Fix round 1, item 3: the drawer has had `profile-error` since M46 and every other write in the
  // file uses it. The dismissal ignoring it was a regression against the file's own convention.
  it('says what a refused dismissal said, in the drawer own error slot', async () => {
    await openDrawer()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/dismissal')
        ? new Response(JSON.stringify({ error: 'no duplicate pair with id p1' }), { status: 404 })
        : new Response(JSON.stringify([pair()]), { status: 200 }),
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-duplicate-dismiss-p1'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('profile-error').textContent).toBe('no duplicate pair with id p1')
    })
    // Nothing was dismissed, so the control still offers the same act.
    expect(screen.getByTestId('profile-duplicate-dismiss-p1').textContent).toBe('Dismiss')
  })

  it('says nothing else looks like this row when there is no pair at all', async () => {
    await openDrawer([])

    expect(duplicatesGroup().textContent).toContain('nothing else in the catalog looks like this row.')
  })

  // D70: an empty group, never an error band -- and never a crash inside somebody's profile either.
  it('treats an answer that is not a list as no pairs at all', async () => {
    await openDrawer({ rows: [] })

    expect(duplicatesGroup().textContent).toContain('nothing else in the catalog looks like this row.')
  })

  it('opens the other template drawer from the pair, keys and all (D69)', async () => {
    const onOpenTemplate = vi.fn()
    await openDrawer([pair()], { onOpenTemplate })

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-duplicate-open-p1'))
    })

    expect(onOpenTemplate).toHaveBeenCalledWith('t2', 'Backend Architect')
  })

  it('renders the other name as TEXT for a caller with no second drawer to open', async () => {
    await openDrawer()

    expect(screen.queryByTestId('profile-duplicate-open-p1')).toBeNull()
    expect(screen.getByTestId('profile-duplicate-p1').textContent).toContain('Backend Architect')
  })
})
