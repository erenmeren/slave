// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderKind } from '@slave-of-ai/control'
import type { CapabilityRecord } from '@slave-of-ai/domain'
import type { CatalogRowView, WorkforceCatalogView } from '../src/server/org.js'
import { CATALOG_SEARCH_DEBOUNCE_MS } from '../src/lib/catalogFilters.js'
import { clearModelSelectCache } from '../src/components/ModelSelect.js'
import { TemplateForm } from '../src/components/workforce/TemplateForm.js'
import { WorkforceCatalog } from '../src/components/workforce/WorkforceCatalog.js'

const routerRefresh = vi.fn()
const replaceState = vi.fn()
let search = ''

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
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
    sourceId: 'catalog-m46/engineering/core-builder',
    sourceDivision: 'engineering',
    importedAt: '2026-09-11T09:00:00.000Z',
    sourceRepository: 'catalog-m46',
    sourceRevision: '0f1e2d3',
    sourceLicense: 'MIT',
    source: 'imported',
    structured: true,
    summary: 'Builds the core module and the tests that hold it up.',
    capabilities: [
      'Design the module boundary',
      'Write the test first',
      'Delete what nobody calls',
      'Read a build back',
    ],
    // M47 R1: the same capabilities resolved to taxonomy keys. Empty here -- these fixtures are
    // M46-era rows, and an unresolved persona bullet is exactly what an empty list means.
    capabilityKeys: [],
    // R8 (2026-09-20 catalogue capability mapping): a fixture row is unmapped by default -- the
    // ORDINARY row, since the mapping pass has not touched most of the catalogue yet.
    mappedCapabilityKeys: [],
    capabilityMappedAt: null,
    capabilityMappingStale: false,
    expertise: ['Load-bearing code'],
    recommendedSkills: ['writing-plans'],
    mappingQuality: 'full',
    overriddenFields: [],
    rawOverride: false,
    // M55 R2/R6: a fixture row is an ordinary imported one -- inert, never toggled, in no pair.
    active: false,
    activationChangedAt: null,
    activationChangedBy: null,
    duplicate: null,
    duplicateCount: 0,
    defaultSkillIds: [],
    hiredCount: 0,
    skills: [],
    workflowPreview: { steps: [], total: 0 },
    ...over,
  }
}

const view = (rows: readonly CatalogRowView[]): WorkforceCatalogView => ({
  rows,
  facets: {
    divisions: ['engineering', 'testing'],
    capabilities: ['Design the module boundary', 'Run the work back'],
    skills: ['writing-plans'],
    domains: [],
  },
  // A fixture IS the whole answer, so the honest total is what it holds and the honest cursor
  // is the absence of one (M55 R3).
  total: rows.length,
  nextCursor: null,
})

/** Two taxonomy rows is the whole fixture this file needs: one the drawer can resolve, and the
 *  absence of a second is what makes an unresolved key unresolved. */
const TAXONOMY: readonly CapabilityRecord[] = [
  {
    key: 'security.application',
    label: 'Application security',
    domain: 'security',
    role: 'security',
    synonyms: [],
  },
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  search = ''
  routerRefresh.mockClear()
  replaceState.mockClear()
  vi.stubGlobal('history', { replaceState })
  fetchMock = vi.fn(async () => new Response(JSON.stringify(view([row()])), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * One keystroke in the search box, plus the wait the box takes before it asks (M55 R3's
 * `CATALOG_SEARCH_DEBOUNCE_MS`). Every assertion below is the one it always was -- what moved is
 * that the request is issued one debounce window after the keystroke instead of on it, so a case
 * about two requests in flight has to let both be issued.
 */
const typeSearch = async (value: string): Promise<void> => {
  await act(async () => {
    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value } })
    await new Promise((resolve) => setTimeout(resolve, CATALOG_SEARCH_DEBOUNCE_MS + 20))
  })
}

describe('WorkforceCatalog rows', () => {
  it('renders a row per template: name, summary, three capability chips and a +N', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    const line = screen.getByTestId('catalog-row-t1')
    expect(within(line).getByText('Core Builder')).toBeTruthy()
    expect(line.textContent).toContain('Builds the core module and the tests that hold it up.')
    expect(within(line).getAllByTestId('catalog-capability-chip')).toHaveLength(3)
    expect(within(line).getByTestId('catalog-capability-more').textContent).toBe('+1')
  })

  // Workforce cards: the catalog is a GRID of persona cards now. `gate:m11-shell` waits for the new
  // template by its `catalog-row-` wrapper (Task 8 moved it off `data-table-row`), so the wrapper
  // is the handle that must survive.
  it('lays the catalog out as persona cards on the card grid, one per template', () => {
    render(<WorkforceCatalog initial={view([row(), row({ id: 't2', name: 'Verifier' })])} />)

    expect(screen.getByTestId('workforce-catalog')).toBeTruthy()
    expect(screen.getByTestId('workforce-card-grid')).toBeTruthy()
    expect(screen.queryByTestId('data-table')).toBeNull()
    const card = within(screen.getByTestId('catalog-row-t1')).getByTestId('workforce-card')
    expect(card.getAttribute('data-variant')).toBe('persona')
    expect(screen.getAllByTestId(/^catalog-row-/u)).toHaveLength(2)
  })

  it('marks where a row came from, and says local for a hand-made template', () => {
    render(
      <WorkforceCatalog
        initial={view([
          row(),
          row({
            id: 't2',
            name: 'Hand Made',
            source: 'local',
            structured: false,
            sourceId: null,
            sourceDivision: null,
            sourceRepository: null,
            importedAt: null,
            capabilities: [],
            mappingQuality: null,
          }),
        ])}
      />,
    )

    expect(screen.getByTestId('catalog-source-t1').textContent).toBe('imported · catalog-m46')
    expect(screen.getByTestId('catalog-source-t2').textContent).toBe('local')
  })

  it('marks a customised row and a raw Markdown override separately', () => {
    render(
      <WorkforceCatalog
        initial={view([
          row({ overriddenFields: ['constraints'] }),
          row({ id: 't2', name: 'Verifier', rawOverride: true }),
        ])}
      />,
    )

    expect(screen.getByTestId('catalog-overridden-t1').textContent).toBe('customised')
    expect(screen.queryByTestId('catalog-overridden-t2')).toBeNull()
    expect(screen.getByTestId('catalog-raw-override-t2').textContent).toBe('raw override')
  })

  // D8: the row keeps the Default model cell the template table had, provider included -- the two
  // assertions M12 Task 13 fix round 1 added to `settings-page.test.tsx`, moved with the surface.
  it('shows the default model and provider, and a dash where there is none', () => {
    render(
      <WorkforceCatalog
        initial={view([row({ defaultModel: 'claude-sonnet-4', defaultProvider: 'cursor' }), row({ id: 't2' })])}
      />,
    )

    expect(within(screen.getByTestId('catalog-row-t1')).getByText('claude-sonnet-4 · cursor')).toBeTruthy()
    expect(within(screen.getByTestId('catalog-row-t2')).getByText('—')).toBeTruthy()
  })

  // The row cells the old `TemplateCatalog` table asserted, on the surface that replaced it --
  // except that R6 files a specialist under its DIVISION, not the role string it was typed with.
  it('files an imported row under its division, keeping the raw role one hover away', () => {
    render(<WorkforceCatalog initial={view([row({ role: 'backend', sourceDivision: 'engineering' })])} />)
    const chip = within(screen.getByTestId('catalog-row-t1')).getByText('engineering')
    expect(chip.getAttribute('title')).toBe('backend')
  })

  it('falls back to the role on a hand-made row, which has no division', () => {
    render(
      <WorkforceCatalog
        initial={view([row({ role: 'backend', sourceDivision: null, source: 'local', structured: false })])}
      />,
    )
    expect(within(screen.getByTestId('catalog-row-t1')).getByText('backend')).toBeTruthy()
  })

  it("hands each card the row's skills and workflow", () => {
    render(
      <WorkforceCatalog
        initial={view([
          row({
            skills: [{ skillId: 'sk1', name: 'pdf', providerName: 'personal', missing: false, process: false, state: 'persona' }],
            workflowPreview: { steps: ['Read the ticket'], total: 4 },
          }),
        ])}
      />,
    )
    const card = screen.getByTestId('catalog-row-t1')
    expect(within(card).getByTestId('card-skill-sk1')).toBeTruthy()
    expect(within(card).getByTestId('card-workflow-step').textContent).toBe('1. Read the ticket')
    expect(within(card).getByTestId('card-workflow-more').textContent).toBe('+3 steps')
  })

  it('offers Clear filters when a filtered answer is empty', async () => {
    search = 'q=nothing-like-it'
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(view([])), { status: 200 }))
    render(<WorkforceCatalog initial={view([])} />)

    const clear = await screen.findByTestId('catalog-empty-clear')
    fireEvent.click(clear)
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce')
  })

  /**
   * Controller ruling F2 (Task 8): a card write must not reset the loaded list to page one. This
   * proves it end to end -- a row past the first page (loaded through `Show more`) keeps its own
   * page-one sibling mounted, and picks up the write itself, when the persona-card write succeeds.
   */
  it('patches a card past the first page in place after a write, without dropping earlier pages', async () => {
    const pageOne = { ...view([row()]), nextCursor: 't1' }
    const pageTwo = { ...view([row({ id: 't2', name: 'Verifier' })]), nextCursor: null }
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/org/templates/')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (url.includes('cursor=')) return new Response(JSON.stringify(pageTwo), { status: 200 })
      return new Response(JSON.stringify(pageOne), { status: 200 })
    })

    render(
      <WorkforceCatalog
        initial={pageOne}
        skillCatalogue={[{ skillId: 's-sql', name: 'sql', providerName: 'personal', description: 'writes sql', missing: false }]}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-more'))
    })
    await waitFor(() => expect(screen.getByTestId('catalog-row-t2')).toBeTruthy())

    const card = screen.getByTestId('catalog-row-t2')
    fireEvent.click(within(card).getByTestId('card-skill-add'))
    fireEvent.click(within(card).getByTestId('skill-picker-option-s-sql'))
    await act(async () => {
      fireEvent.click(within(card).getByTestId('skill-picker-confirm'))
    })

    // Both pages are still on screen -- a write on page two must not truncate the list to page one.
    expect(screen.getByTestId('catalog-row-t1')).toBeTruthy()
    expect(within(card).getByTestId('card-skill-s-sql')).toBeTruthy()
  })

  /**
   * Fix round 1 (coordinator review, Important): `resyncAfterRefusal`'s own re-fetch used to have no
   * error handling -- a rejected `fetch` became an unhandled promise rejection. This proves the fix:
   * a refused card write's resync whose OWN fetch fails must not reject unhandled, must not drop any
   * page already loaded, and must surface the same failure state `reload` uses elsewhere on this tab.
   */
  it('shows the stale-catalog failure and keeps every loaded page when a refusal’s own resync fails, with no unhandled rejection', async () => {
    const pageOne = { ...view([row()]), nextCursor: 't1' }
    const pageTwo = { ...view([row({ id: 't2', name: 'Verifier' })]), nextCursor: null }
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/org/templates/')) {
        return new Response(JSON.stringify({ error: 'the skill sql is missing from disk' }), { status: 409 })
      }
      if (url.includes('cursor=')) return new Response(JSON.stringify(pageTwo), { status: 200 })
      // The resync's own re-fetch (bare, no cursor) is what fix round 1 guards -- a rejected
      // `fetch`, the same shape a network failure takes.
      throw new Error('network down')
    })

    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)

    try {
      render(
        <WorkforceCatalog
          initial={pageOne}
          skillCatalogue={[{ skillId: 's-sql', name: 'sql', providerName: 'personal', description: 'writes sql', missing: false }]}
        />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('catalog-more'))
      })
      await waitFor(() => expect(screen.getByTestId('catalog-row-t2')).toBeTruthy())

      const card = screen.getByTestId('catalog-row-t2')
      fireEvent.click(within(card).getByTestId('card-skill-add'))
      fireEvent.click(within(card).getByTestId('skill-picker-option-s-sql'))
      await act(async () => {
        fireEvent.click(within(card).getByTestId('skill-picker-confirm'))
      })

      await waitFor(() => expect(screen.getByTestId('catalog-stale')).toBeTruthy())
      // Neither page was dropped by the failed resync.
      expect(screen.getByTestId('catalog-row-t1')).toBeTruthy()
      expect(screen.getByTestId('catalog-row-t2')).toBeTruthy()
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('never prints a bare mapping-quality token as visible text (docs/ia.md rule 3)', () => {
    render(<WorkforceCatalog initial={view([row({ mappingQuality: 'partial' })])} />)
    const line = screen.getByTestId('catalog-row-t1')
    expect(line.textContent).not.toContain('partial')
    expect(line.getAttribute('data-mapping-quality')).toBe('partial')
  })

  it('says so when nothing matches, without pretending the catalog is empty', () => {
    render(<WorkforceCatalog initial={view([])} />)
    expect(screen.getByTestId('catalog-empty')).toBeTruthy()
  })

  it('counts what it is showing', () => {
    render(<WorkforceCatalog initial={view([row(), row({ id: 't2' })])} />)
    expect(screen.getByTestId('catalog-count').textContent).toBe('2 templates')
  })

  it('says so when the refetch fails, and keeps the last answer on screen', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }))

    await typeSearch('nothing')

    await waitFor(() => expect(screen.getByTestId('catalog-stale')).toBeTruthy())
    expect(screen.getByTestId('catalog-row-t1')).toBeTruthy()
  })
})

describe('WorkforceCatalog filters', () => {
  it('fetches the filtered catalog and writes the search into the URL without a router push', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    await typeSearch('builder')

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog?q=builder'))
    expect(replaceState).toHaveBeenCalledWith(null, '', '/workforce?q=builder')
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  /**
   * `gate:m46-workforce-catalog` stage 2c, as a unit case (M55 R3 fix): a filter changed DURING the
   * debounce window has to survive the keystroke's own push. The timer used to carry the filters of
   * the render that armed it, so the chip clicked 100 ms after a keystroke was reverted 150 ms
   * later by a request nobody made.
   */
  it('merges a debounced search into the filters as they are when it fires, never as they were', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'Gate' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-source-chip-local'))
      await new Promise((resolve) => setTimeout(resolve, CATALOG_SEARCH_DEBOUNCE_MS + 20))
    })

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.at(-1)).toBe('/api/org/catalog?q=Gate&source=local')
    expect(urls).not.toContain('/api/org/catalog?q=Gate&source=imported')
  })

  it('toggles a source chip on and off', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-source-chip-local'))
    })
    expect(screen.getByTestId('catalog-source-chip-local').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog?source=local'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-source-chip-local'))
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog'))
  })

  it('filters by division and by skill from the facet menus', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-division-select'), { target: { value: 'testing' } })
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog?division=testing'))

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-skill-select'), { target: { value: 'writing-plans' } })
    })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog?division=testing&skill=writing-plans'),
    )
  })

  it('clears every filter at once, and offers no Clear while none is set', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)
    expect(screen.queryByTestId('catalog-clear-filters')).toBeNull()

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-capability-select'), {
        target: { value: 'Run the work back' },
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-clear-filters'))
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog'))
    expect(replaceState).toHaveBeenCalledWith(null, '', '/workforce')
  })

  /**
   * Fix round 1, important 1. The search box fires one request per keystroke, so `?q=buil` and
   * `?q=builder` are in flight together as a matter of course -- and the shorter query, matching
   * more rows, is exactly the one likely to answer LAST. The list must show the latest request's
   * answer, not the last one to arrive.
   */
  it('ignores a superseded answer that lands after a newer one', async () => {
    const release: Record<string, (view: WorkforceCatalogView) => void> = {}
    fetchMock.mockImplementation(
      async (url: string) =>
        await new Promise<Response>((resolve) => {
          release[url] = (body) => {
            resolve(new Response(JSON.stringify(body), { status: 200 }))
          }
        }),
    )
    render(<WorkforceCatalog initial={view([row()])} />)

    await typeSearch('buil')
    await typeSearch('builder')
    await waitFor(() => expect(Object.keys(release)).toHaveLength(2))

    // The LATER query answers first, then the earlier one -- the race, made deterministic.
    await act(async () => {
      release['/api/org/catalog?q=builder']?.(view([row({ id: 'later', name: 'The later answer' })]))
    })
    await act(async () => {
      release['/api/org/catalog?q=buil']?.(view([row({ id: 'earlier', name: 'The earlier answer' })]))
    })

    expect(screen.getByTestId('catalog-row-later')).toBeTruthy()
    expect(screen.queryByTestId('catalog-row-earlier')).toBeNull()
    expect(screen.queryByTestId('catalog-stale')).toBeNull()
  })

  // A superseded request that FAILS says nothing either: its answer was never going to render.
  it('stays quiet when a superseded request fails', async () => {
    const release: Record<string, (response: Response) => void> = {}
    fetchMock.mockImplementation(
      async (url: string) =>
        await new Promise<Response>((resolve) => {
          release[url] = resolve
        }),
    )
    render(<WorkforceCatalog initial={view([row()])} />)

    await typeSearch('buil')
    await typeSearch('builder')
    await waitFor(() => expect(Object.keys(release)).toHaveLength(2))

    await act(async () => {
      release['/api/org/catalog?q=builder']?.(new Response(JSON.stringify(view([row()])), { status: 200 }))
    })
    await act(async () => {
      release['/api/org/catalog?q=buil']?.(new Response('nope', { status: 500 }))
    })

    expect(screen.queryByTestId('catalog-stale')).toBeNull()
  })

  // Fix round 1, minor 5: a refetch in flight says so, and the previous answer stays readable
  // underneath rather than the list emptying itself on every keystroke.
  it('says it is reading while a refetch is in flight', async () => {
    let release: ((response: Response) => void) | null = null
    fetchMock.mockImplementation(
      async () =>
        await new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    render(<WorkforceCatalog initial={view([row()])} />)
    expect(screen.queryByTestId('catalog-loading')).toBeNull()

    await typeSearch('builder')

    expect(screen.getByTestId('catalog-loading')).toBeTruthy()
    expect(screen.getByTestId('catalog-row-t1')).toBeTruthy()

    await act(async () => {
      release?.(new Response(JSON.stringify(view([row()])), { status: 200 }))
    })
    expect(screen.queryByTestId('catalog-loading')).toBeNull()
  })

  it('opens with the filters the URL arrived with', async () => {
    search = 'tab=catalog&capability=Run+the+work+back'
    render(<WorkforceCatalog initial={view([row()])} />)

    expect((screen.getByTestId('catalog-capability-select') as HTMLSelectElement).value).toBe(
      'Run the work back',
    )
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog?capability=Run+the+work+back'),
    )
  })

  it('does not refetch on mount when the URL carried no filter -- the server already answered', () => {
    render(<WorkforceCatalog initial={view([row()])} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ProfileDrawer', () => {
  const profile = {
    templateId: 't1',
    name: 'Core Builder',
    upstream: {
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
      source: {
        repository: 'catalog-m46',
        path: 'engineering/core-builder.md',
        revision: '0f1e2d3',
        license: 'MIT',
        importedAt: '2026-09-11T09:00:00.000Z',
        mappingQuality: 'full' as const,
      },
    },
    overrides: {},
    effective: null as never,
    markdown: '## Who you are\nThe slave that lays the load-bearing parts first.',
    rawOverride: false,
    overridden: [] as readonly string[],
  }
  const withEffective = { ...profile, effective: profile.upstream }

  const openDrawer = async (
    over: Partial<typeof withEffective> = {},
    catalogRow: CatalogRowView = row(),
    taxonomy: readonly CapabilityRecord[] = [],
  ): Promise<void> => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/profile')
        ? new Response(JSON.stringify({ ...withEffective, ...over }), { status: 200 })
        : // M55 R6: the drawer reads its pairs separately from its profile, and this fixture row is
          // in none of them. `catalog-duplicates.test.tsx` is where that group is exercised.
          url.includes('/duplicates')
          ? new Response(JSON.stringify([]), { status: 200 })
          : new Response(JSON.stringify(view([catalogRow])), { status: 200 }),
    )
    render(<WorkforceCatalog initial={view([catalogRow])} taxonomy={taxonomy} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-row-t1'))
    })
    await waitFor(() => expect(screen.getByTestId('profile-drawer')).toBeTruthy())
  }

  /**
   * Final review, finding 1: the card's chips and the drawer's whole-set editor are ONE list. The
   * editor PATCHes `{ skillIds }` -- the whole set -- so a drawer fed a stale list silently undoes
   * whatever the card wrote since the page loaded. A stateful fake route here, so every read back
   * is what the writes before it made.
   */
  describe('the card and the drawer edit one skill list', () => {
    const CATALOGUE = [
      { skillId: 's-sql', name: 'sql', providerName: 'personal', description: 'writes sql', missing: false },
      { skillId: 's-pdf', name: 'pdf', providerName: 'personal', description: 'reads pdfs', missing: false },
      { skillId: 's-git', name: 'git', providerName: 'personal', description: 'commits', missing: false },
    ]
    const chipOf = (skillId: string): CatalogRowView['skills'][number] => {
      const skill = CATALOGUE.find((one) => one.skillId === skillId)
      return { skillId, name: skill?.name ?? skillId, providerName: 'personal', missing: false, process: false, state: 'persona' }
    }

    /** The catalog route pages `pageSize` rows at a time; the skills route applies each PATCH and
     *  records its body. */
    const serve = (rows: readonly CatalogRowView[], pageSize = rows.length): { readonly bodies: unknown[] } => {
      const held = new Map(rows.map((one) => [one.id, [...one.defaultSkillIds]]))
      const bodies: unknown[] = []
      const current = (one: CatalogRowView): CatalogRowView => {
        const ids = held.get(one.id) ?? []
        return { ...one, defaultSkillIds: ids, skills: ids.map(chipOf) }
      }
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/profile')) return new Response(JSON.stringify(withEffective), { status: 200 })
        if (url.includes('/duplicates')) return new Response(JSON.stringify([]), { status: 200 })
        if (url.endsWith('/skills') && init?.method !== 'PATCH') {
          // The by-id read a drawer takes for a persona that is not on the loaded page.
          const ids = held.get(url.split('/')[4] ?? '') ?? []
          return new Response(JSON.stringify({ defaultSkillIds: ids, hiredCount: 0 }), { status: 200 })
        }
        if (url.endsWith('/skills')) {
          const id = url.split('/')[4] ?? ''
          const body = JSON.parse(String(init?.body)) as { skillIds?: string[]; add?: string[]; remove?: string[] }
          bodies.push(body)
          const ids = body.skillIds ?? [...(held.get(id) ?? []).filter((one) => !(body.remove ?? []).includes(one)), ...(body.add ?? [])]
          held.set(id, ids)
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        const cursor = new URL(url, 'http://local').searchParams.get('cursor')
        const start = cursor === null ? 0 : rows.findIndex((one) => one.id === cursor) + 1
        const slice = rows.slice(start, start + pageSize)
        return new Response(
          JSON.stringify({
            ...view(slice.map(current)),
            total: rows.length,
            nextCursor: start + pageSize < rows.length ? (slice.at(-1)?.id ?? null) : null,
          }),
          { status: 200 },
        )
      })
      return { bodies }
    }

    const openCardDrawer = async (id: string): Promise<void> => {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`catalog-open-${id}`))
      })
      await screen.findByTestId('template-skills-editor')
    }

    const drawerAdd = async (skillId: string): Promise<void> => {
      fireEvent.change(screen.getByTestId('template-skill-add'), { target: { value: skillId } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('template-skill-add-submit'))
      })
    }

    it('keeps a skill the card added when the drawer then edits the list', async () => {
      const { bodies } = serve([row()])
      render(<WorkforceCatalog initial={view([row()])} skillCatalogue={CATALOGUE} />)

      const card = screen.getByTestId('catalog-row-t1')
      fireEvent.click(within(card).getByTestId('card-skill-add'))
      fireEvent.click(within(card).getByTestId('skill-picker-option-s-sql'))
      await act(async () => {
        fireEvent.click(within(card).getByTestId('skill-picker-confirm'))
      })

      await openCardDrawer('t1')
      await drawerAdd('s-pdf')
      expect(bodies.at(-1)).toEqual({ skillIds: ['s-sql', 's-pdf'] })
    })

    it('does not bring back a skill the card removed when the drawer then edits the list', async () => {
      const held = row({ defaultSkillIds: ['s-sql'], skills: [chipOf('s-sql')] })
      const { bodies } = serve([held])
      render(<WorkforceCatalog initial={view([held])} skillCatalogue={CATALOGUE} />)

      await act(async () => {
        fireEvent.click(within(screen.getByTestId('catalog-row-t1')).getByTestId('card-skill-remove-s-sql'))
      })

      await openCardDrawer('t1')
      await drawerAdd('s-pdf')
      expect(bodies.at(-1)).toEqual({ skillIds: ['s-pdf'] })
    })

    it('keeps every loaded page after a drawer edit on a "Show more" row, and a second edit keeps the first', async () => {
      const second = row({ id: 't2', name: 'Verifier' })
      const { bodies } = serve([row(), second], 1)
      render(<WorkforceCatalog initial={{ ...view([row()]), total: 2, nextCursor: 't1' }} skillCatalogue={CATALOGUE} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('catalog-more'))
      })
      await screen.findByTestId('catalog-row-t2')

      await openCardDrawer('t2')
      await drawerAdd('s-sql')
      await waitFor(() => expect(within(screen.getByTestId('catalog-row-t2')).getByTestId('card-skill-s-sql')).toBeTruthy())
      expect(screen.getByTestId('catalog-row-t1')).toBeTruthy()

      await drawerAdd('s-pdf')
      expect(bodies.at(-1)).toEqual({ skillIds: ['s-sql', 's-pdf'] })
    })

    /**
     * The Duplicates data-loss repro: the drawer's Duplicates group opens the OTHER persona's
     * drawer, and that persona is commonly not on the loaded page. Seeding its editor with `[]`
     * made the first Add a whole-set PATCH of one skill -- wiping every default skill it had, and
     * with them the effective skills of everybody hired from it.
     */
    it('keeps the existing default skills of a persona opened from Duplicates that is not on the loaded page', async () => {
      const other = row({ id: 't9', name: 'Backend Architect', defaultSkillIds: ['s-sql', 's-git'], skills: [chipOf('s-sql'), chipOf('s-git')] })
      const { bodies } = serve([row(), other], 1)
      const base = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      const pair = {
        id: 'p1', class: 'exact', basis: 'content_hash', score: 1, detectedAt: '2026-09-14T09:00:00.000Z',
        dismissedAt: null, dismissedBy: null, aId: 't1', aName: 'Core Builder', bId: 't9', bName: 'Backend Architect',
      }
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith('/t1/duplicates') ? new Response(JSON.stringify([pair]), { status: 200 }) : base(input, init),
      )
      render(<WorkforceCatalog initial={{ ...view([row()]), total: 2, nextCursor: 't1' }} skillCatalogue={CATALOGUE} />)

      await openCardDrawer('t1')
      await act(async () => {
        fireEvent.click(await screen.findByTestId('profile-duplicate-open-p1'))
      })
      expect(screen.queryByTestId('catalog-row-t9')).toBeNull()
      // The editor shows the persona's REAL set before it offers an Add.
      await screen.findByTestId('template-skill-s-git')
      expect(screen.getByTestId('template-skill-s-sql')).toBeTruthy()

      await drawerAdd('s-pdf')
      expect(bodies.at(-1)).toEqual({ skillIds: ['s-sql', 's-git', 's-pdf'] })

      // After the save the drawer re-reads the persona by id, so a second edit builds on the first.
      await screen.findByTestId('template-skill-s-pdf')
      await act(async () => {
        fireEvent.click(screen.getByTestId('template-skill-remove-s-sql'))
      })
      expect(bodies.at(-1)).toEqual({ skillIds: ['s-git', 's-pdf'] })
    })

    it('never offers the editor while the persona’s set is unknown, and says why when it cannot be read', async () => {
      serve([row()])
      const base = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      const pair = {
        id: 'p1', class: 'exact', basis: 'content_hash', score: 1, detectedAt: '2026-09-14T09:00:00.000Z',
        dismissedAt: null, dismissedBy: null, aId: 't1', aName: 'Core Builder', bId: 't9', bName: 'Backend Architect',
      }
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/t1/duplicates')) return new Response(JSON.stringify([pair]), { status: 200 })
        if (url.endsWith('/t9/skills')) return new Response('nope', { status: 500 })
        return base(input, init)
      })
      render(<WorkforceCatalog initial={view([row()])} skillCatalogue={CATALOGUE} />)

      await openCardDrawer('t1')
      await act(async () => {
        fireEvent.click(await screen.findByTestId('profile-duplicate-open-p1'))
      })
      await screen.findByTestId('template-skills-unknown')
      expect(screen.queryByTestId('template-skills-editor')).toBeNull()
      expect(screen.queryByTestId('template-skill-add-submit')).toBeNull()
    })

    // Task 8's deferred minor: `patchedSkills`' two other branches, at the catalog level.
    it('drops a removed chip in place, and leaves the row as it was on a refusal', async () => {
      const held = row({ defaultSkillIds: ['s-sql'], skills: [chipOf('s-sql')] })
      serve([held])
      render(<WorkforceCatalog initial={view([held])} skillCatalogue={CATALOGUE} />)

      await act(async () => {
        fireEvent.click(within(screen.getByTestId('catalog-row-t1')).getByTestId('card-skill-remove-s-sql'))
      })
      expect(within(screen.getByTestId('catalog-row-t1')).queryByTestId('card-skill-s-sql')).toBeNull()

      const refusals = fetchMock.getMockImplementation()
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith('/skills')
          ? new Response(JSON.stringify({ error: 'the skill git is missing from disk' }), { status: 409 })
          : (refusals as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)(input, init),
      )
      const card = screen.getByTestId('catalog-row-t1')
      fireEvent.click(within(card).getByTestId('card-skill-add'))
      fireEvent.click(within(card).getByTestId('skill-picker-option-s-git'))
      await act(async () => {
        fireEvent.click(within(card).getByTestId('skill-picker-confirm'))
      })
      expect(within(screen.getByTestId('catalog-row-t1')).queryByTestId('card-skill-s-git')).toBeNull()
      expect(within(screen.getByTestId('catalog-row-t1')).getByTestId('card-skill-error').textContent).toContain('missing from disk')
    })
  })

  // M47 §2: the row's MATCHABLE keys, resolved to the taxonomy's own words, above the persona's
  // free-text bullets -- the same `capability-chip` the Organization tab prints, so one capability
  // reads the same in both places.
  it('resolves the row\'s capability keys to labels, with the key still in the title', async () => {
    await openDrawer({}, row({ capabilityKeys: ['security.application', 'nope.missing'] }), TAXONOMY)

    const group = screen
      .getAllByTestId('details-group')
      .find((node) => node.getAttribute('data-group') === 'capabilities')
    expect(group).toBeTruthy()
    const chips = within(group as HTMLElement).getAllByTestId('capability-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual(['Application security', 'nope.missing'])
    expect(chips[0]?.getAttribute('title')).toBe('security.application')
  })

  // R8 (2026-09-20 catalogue capability mapping): each chip says whether it was matched on the
  // persona's own words or chosen by a model, and a stale mapping says so beside the chips.
  it('marks each capability chip as matched or mapped, and says when the mapping is stale', async () => {
    await openDrawer(
      {},
      row({
        capabilityKeys: ['backend.services', 'operations.ci-cd'],
        mappedCapabilityKeys: ['operations.ci-cd'],
        // Fix round 1, I2: a string, not a `Date` -- `CatalogRowView.capabilityMappedAt` crosses
        // the client boundary as ISO already, same as `importedAt` and `activationChangedAt`.
        capabilityMappedAt: '2026-09-01T00:00:00.000Z',
        capabilityMappingStale: true,
      }),
      TAXONOMY,
    )
    const keys = await screen.findByTestId('profile-capability-keys')
    const chips = within(keys).getAllByTestId('capability-chip')
    expect(chips.map((chip) => chip.getAttribute('data-provenance'))).toEqual(['matched', 'mapped'])
    // `.textContent` rather than jest-dom's `toHaveTextContent` -- this repo's vitest setup
    // carries no jest-dom matchers (`projects-panel.test.tsx` notes the same).
    expect(within(keys).getByTestId('profile-capability-mapping').textContent).toContain('mapping is stale')
  })

  // Fix round 1, minor: the `'mapped'` branch had no test of its own -- the stale case above
  // covers `data-provenance` but never a CURRENT mapping, and the explainer copy for a mapped row
  // (below the chips) went untested.
  it('says a mapping is current, and marks a key both the matcher and the model picked as mapped', async () => {
    await openDrawer(
      {},
      row({
        capabilityKeys: ['backend.services', 'operations.ci-cd'],
        mappedCapabilityKeys: ['operations.ci-cd'],
        capabilityMappedAt: '2026-09-18T12:00:00.000Z',
        capabilityMappingStale: false,
        active: true,
      }),
      TAXONOMY,
    )
    const keys = await screen.findByTestId('profile-capability-keys')
    const chips = within(keys).getAllByTestId('capability-chip')
    expect(chips.map((chip) => chip.getAttribute('data-provenance'))).toEqual(['matched', 'mapped'])
    expect(within(keys).getByTestId('profile-capability-mapping').textContent).toContain('chosen or confirmed by a model')
  })

  // Fix round 1, I1: an ACTIVE row with no `capabilityMappedAt` is "not yet mapped" -- the pass
  // will reach it on its next run. `active: true` here is load-bearing: the base `row()` fixture
  // is inactive, which is a DIFFERENT state (below) with its own copy.
  it('says when a persona has not been mapped yet', async () => {
    await openDrawer(
      {},
      row({
        capabilityKeys: ['backend.services'],
        mappedCapabilityKeys: [],
        capabilityMappedAt: null,
        capabilityMappingStale: false,
        active: true,
      }),
      TAXONOMY,
    )
    const keys = await screen.findByTestId('profile-capability-keys')
    expect(within(keys).getByTestId('profile-capability-mapping').textContent).toContain('not yet mapped')
  })

  // Fix round 1, I1/minor: the `'inactive'` branch is its OWN state, not a flavour of `'none'` --
  // the pass and `capabilities map` both skip an inactive row, so this line must not promise a
  // re-map the daemon will not run until the row is activated.
  it('says a persona is not mapped while inactive, never that a re-map is coming', async () => {
    await openDrawer(
      {},
      row({
        capabilityKeys: ['backend.services'],
        mappedCapabilityKeys: [],
        capabilityMappedAt: null,
        capabilityMappingStale: false,
        active: false,
      }),
      TAXONOMY,
    )
    const keys = await screen.findByTestId('profile-capability-keys')
    const line = within(keys).getByTestId('profile-capability-mapping').textContent
    expect(line).toContain('not mapped while inactive')
    expect(line).not.toContain('not yet mapped')
  })

  // Fix round 1, I3: a previous round's regression guard was lost when the block's condition
  // changed -- `capabilityKeys: []` now renders the block (for the mapping line), and
  // `CapabilityChips` itself still prints "no capabilities recorded" for an empty list. Restored
  // here, and renamed to say what this test actually proves now: the block shows with its mapping
  // line and NO chip-list placeholder, and the persona's own bullets are untouched either way.
  it('shows the mapping line but never "no capabilities recorded" for a template with no keys', async () => {
    await openDrawer({}, row({ active: true }), TAXONOMY)

    const keys = screen.getByTestId('profile-capability-keys')
    expect(within(keys).getByTestId('profile-capability-mapping').textContent).toContain('not yet mapped')
    expect(screen.getByTestId('profile-drawer').textContent).not.toContain('no capabilities recorded')
    // The persona's own bullets are untouched by the guard.
    expect(screen.getByTestId('profile-field-capabilities').textContent).toContain('Design the module boundary')
  })

  it('names the keys the taxonomy does not have, and says how to make them matchable', async () => {
    await openDrawer({}, row({ capabilityKeys: ['security.application', 'nope.missing'] }), TAXONOMY)

    const caption = screen.getByTestId('profile-capabilities-unresolved')
    expect(caption.textContent).toContain('nope.missing')
    expect(caption.textContent).toContain('capabilities add')
  })

  it('opens on a row and shows every field group with its label', async () => {
    await openDrawer()

    expect(screen.getByTestId('profile-drawer-title').textContent).toBe('Core Builder')
    const groups = screen.getAllByTestId('details-group').map((node) => node.getAttribute('data-group'))
    expect(groups).toEqual([
      'identity',
      'mission',
      'capabilities',
      'skills',
      'expertise',
      'principles',
      'constraints',
      'workflow',
      'deliverables',
      'success',
      'collaboration',
      'source',
      // M55 R6's fourteenth, between Source and the persona's own words.
      'duplicates',
      'body',
      'advanced',
    ])
  })

  it('labels every field from the domain table, never by its key', async () => {
    await openDrawer()
    const drawer = screen.getByTestId('profile-drawer')
    expect(within(drawer).getByText('Who you are')).toBeTruthy()
    expect(within(drawer).getByText('Working with others')).toBeTruthy()
    expect(within(drawer).getByText('Suggested role')).toBeTruthy()
    expect(drawer.textContent).not.toContain('collaborationHints')
  })

  it('keeps the raw Markdown inside Advanced and nowhere else (R6)', async () => {
    await openDrawer()
    expect(screen.queryByTestId('profile-markdown')).toBeNull()

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('profile-drawer')).getByText('Advanced'))
    })

    expect(screen.getByTestId('profile-markdown').textContent).toContain('## Who you are')
    expect(screen.getByTestId('profile-raw-input')).toBeTruthy()
  })

  it('customises one field into an override and PATCHes only that field', async () => {
    await openDrawer()

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-field-input-constraints'), {
        target: { value: 'You MUST ship behind a flag' },
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-field-save-constraints'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates/t1/overrides',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ patch: { constraints: ['You MUST ship behind a flag'] } }),
      }),
    )
  })

  // E21: the suggested role is the one field an override could not change the behaviour of, so it
  // is not in `PROFILE_OVERRIDABLE_FIELDS` and the drawer offers no editor for it. A Save here
  // would be a control that answers 409 every time it is pressed.
  it('shows the suggested role but never offers to customise it', async () => {
    await openDrawer()
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })

    expect(screen.getByTestId('profile-field-runtimeRole').textContent).toContain('engineering')
    expect(screen.queryByTestId('profile-field-input-runtimeRole')).toBeNull()
    expect(screen.queryByTestId('profile-field-save-runtimeRole')).toBeNull()
    expect(screen.getByTestId('profile-field-input-mission')).toBeTruthy()
  })

  // Fix round 1, minor 2: `body` is overridable and had no group -- the API offered an edit the
  // drawer did not. `Advanced`'s raw box is a different thing: it REPLACES the rendered profile,
  // where this composes with the other thirteen fields.
  it("gives the persona's own words a group of their own, editable like any other field", async () => {
    await openDrawer()
    const groups = screen.getAllByTestId('details-group')
    const body = groups.find((node) => node.getAttribute('data-group') === 'body')
    expect(body?.textContent).toContain('You write the module everything else stands on.')
    expect(within(screen.getByTestId('profile-drawer')).getByText('In their own words')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-field-input-body'), { target: { value: 'Mine now.' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-field-save-body'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates/t1/overrides',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ patch: { body: 'Mine now.' } }) }),
    )
  })

  it('badges an overridden field and offers Reset, which DELETEs it', async () => {
    await openDrawer({ overrides: { constraints: ['Mine'] }, overridden: ['constraints'] })
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })

    expect(screen.getByTestId('profile-field-overridden-constraints')).toBeTruthy()
    expect(screen.queryByTestId('profile-field-overridden-workflow')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-field-reset-constraints'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates/t1/overrides/constraints',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  // Final wave, M2: the same guard the raw Save has had since round 1, for the same reason. A
  // Save pressed on a textarea nobody typed in would write the EFFECTIVE value back as an
  // override -- pinning that field against every future import, having changed nothing.
  it('will not save a field that has not been edited', async () => {
    await openDrawer()
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })

    const save = (): HTMLButtonElement => screen.getByTestId('profile-field-save-summary') as HTMLButtonElement
    expect(save().disabled).toBe(true)

    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-field-input-summary'), { target: { value: 'Mine.' } })
    })
    expect(save().disabled).toBe(false)

    // Typed back to exactly the effective text is untouched again.
    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-field-input-summary'), {
        target: { value: withEffective.effective.summary },
      })
    })
    expect(save().disabled).toBe(true)
  })

  // Final wave, M3: `load()` used to clear EVERY draft, so saving one field threw away the text
  // an operator had typed into the others -- silently, under a click that said Save.
  it('keeps the other fields\u2019 unsaved text when one field is saved', async () => {
    await openDrawer()
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })

    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-field-input-summary'), { target: { value: 'Saved summary.' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-field-input-mission'), { target: { value: 'Still being typed.' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-field-save-summary'))
    })

    // The saved field goes back to the server's answer; the other one keeps what was typed.
    expect((screen.getByTestId('profile-field-input-mission') as HTMLTextAreaElement).value).toBe(
      'Still being typed.',
    )
    expect((screen.getByTestId('profile-field-input-summary') as HTMLTextAreaElement).value).toBe(
      withEffective.effective.summary,
    )
  })

  it('shows the refusal text beside the field when the write is declined', async () => {
    await openDrawer()
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/overrides')
        ? new Response(
            JSON.stringify({ error: 'these profile changes cannot be stored: capabilities expected array' }),
            { status: 409 },
          )
        : new Response(JSON.stringify(withEffective), { status: 200 }),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })
    // Typed, because an untouched Save is disabled (final wave, M2) and would write nothing.
    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-field-input-constraints'), { target: { value: 'Mine' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-field-save-constraints'))
    })

    await waitFor(() => expect(screen.getByTestId('profile-error').textContent).toContain('cannot be stored'))
  })

  // R5 + the controller's ruling: a raw override and the field overrides do NOT compose -- the
  // last write wins -- so the drawer says the raw one replaces the rendered text and offers the
  // way back out in the same breath.
  it('writes a raw override through PUT, and offers to remove it once one stands', async () => {
    await openDrawer({ rawOverride: true })
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('profile-drawer')).getByText('Advanced'))
    })

    expect(screen.getByTestId('profile-raw-override-notice').textContent).toContain('replaces')

    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-raw-input'), { target: { value: '# Mine' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-raw-save'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates/t1/profile',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ profile: '# Mine' }) }),
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-raw-clear'))
    })
    // Final wave, I2: NOT `PUT { profile: null }`. That wrote a null profile and left
    // `profileSha256` at the last render's stamp, so the raw-override predicate stayed true and
    // every later import skipped the row `locally_edited` -- permanently, with no profile at all.
    // The empty overrides patch re-renders the effective spec and re-stamps the hash, which is the
    // only way back to a row an import will speak to again.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates/t1/overrides',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ patch: {} }) }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/org/templates/t1/profile',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ profile: null }) }),
    )
  })

  // The copy beside the two buttons has to be true, because it is the only place an operator is
  // told what Clear it does (final wave, I2).
  it('says clearing restores the rendered profile rather than emptying it', async () => {
    await openDrawer({ rawOverride: true })
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('profile-drawer')).getByText('Advanced'))
    })
    const notice = screen.getByTestId('profile-raw-clear-notice').textContent ?? ''
    expect(notice).toContain('rendered profile')
    expect(notice).not.toContain('without a profile')
  })

  // Fix round 1, minor 6: an untouched Save would have written the rendered profile back AS a raw
  // override -- freezing the row against every future import, having changed nothing.
  it('will not save a raw override that has not been typed', async () => {
    await openDrawer()
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('profile-drawer')).getByText('Advanced'))
    })

    expect((screen.getByTestId('profile-raw-save') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-raw-input'), { target: { value: '# Mine' } })
    })
    expect((screen.getByTestId('profile-raw-save') as HTMLButtonElement).disabled).toBe(false)

    // Typed back to exactly what is stored is untouched again.
    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-raw-input'), { target: { value: profile.markdown } })
    })
    expect((screen.getByTestId('profile-raw-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers no remove affordance while no raw override stands', async () => {
    await openDrawer()
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('profile-drawer')).getByText('Advanced'))
    })

    expect(screen.queryByTestId('profile-raw-override-notice')).toBeNull()
    expect(screen.queryByTestId('profile-raw-clear')).toBeNull()
  })

  it('shows the source record, licence and revision included', async () => {
    await openDrawer()
    const source = screen
      .getAllByTestId('details-group')
      .find((node) => node.getAttribute('data-group') === 'source')
    expect(source?.textContent).toContain('catalog-m46')
    expect(source?.textContent).toContain('0f1e2d3')
    expect(source?.textContent).toContain('MIT')
    expect(source?.textContent).toContain('mapped in full')
  })

  it('offers no Customise on a template with no structured profile', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/profile')
        ? new Response(JSON.stringify({ ...withEffective, upstream: null, effective: null }), { status: 200 })
        : new Response(JSON.stringify(view([row({ structured: false })])), { status: 200 }),
    )
    render(<WorkforceCatalog initial={view([row({ structured: false })])} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-row-t1'))
    })
    await waitFor(() => expect(screen.getByTestId('profile-drawer')).toBeTruthy())

    expect(screen.queryByTestId('profile-customise')).toBeNull()
    expect(screen.getByTestId('profile-unstructured').textContent).toContain('has not been mapped')
  })

  it('says so when the profile cannot be read at all', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/profile')
        ? new Response(JSON.stringify({ error: 'that template is gone' }), { status: 404 })
        : new Response(JSON.stringify(view([row()])), { status: 200 }),
    )
    render(<WorkforceCatalog initial={view([row()])} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-row-t1'))
    })

    await waitFor(() => expect(screen.getByTestId('profile-load-error')).toBeTruthy())
  })
})

describe('the hand-made template form, kept on the tab', () => {
  it('creates a template and refetches the catalog', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)
    fetchMock.mockClear()

    fireEvent.change(screen.getByTestId('template-name-input'), { target: { value: 'Hand Made' } })
    fireEvent.change(screen.getByTestId('template-role-input'), { target: { value: 'backend' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('template-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/org/templates', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog'))
  })

  // Fix round 1, minor 7: the row an operator just created is not in the answer already on screen,
  // so a single failed refetch would have hidden their own template behind a stale-data band.
  it('retries the refetch once after a creation, rather than hiding the new row', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)
    let catalogGets = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.startsWith('/api/org/catalog')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      catalogGets += 1
      return catalogGets === 1
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify(view([row(), row({ id: 'made', name: 'Hand Made' })])), { status: 200 })
    })

    fireEvent.change(screen.getByTestId('template-name-input'), { target: { value: 'Hand Made' } })
    fireEvent.change(screen.getByTestId('template-role-input'), { target: { value: 'backend' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('template-submit'))
    })

    await waitFor(() => expect(screen.getByTestId('catalog-row-made')).toBeTruthy())
    expect(catalogGets).toBe(2)
    expect(screen.queryByTestId('catalog-stale')).toBeNull()
  })

  it('asks twice before deleting, naming the catalog-slave count', async () => {
    render(<WorkforceCatalog initial={view([row({ catalogSlaveCount: 3, name: 'Backend Developer' })])} />)

    fireEvent.click(screen.getByTestId('template-delete'))
    expect(screen.getByTestId('template-delete-confirm').textContent).toBe(
      'deletes Backend Developer and its 3 catalog slaves; project slaves keep their role',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('template-delete-confirm'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/templates/t1', expect.objectContaining({ method: 'DELETE' }))
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('does not open the profile drawer when the delete control is used', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    fireEvent.click(screen.getByTestId('template-delete'))

    expect(screen.queryByTestId('profile-drawer')).toBeNull()
  })
})

/**
 * MOVED from `settings-page.test.tsx`'s `describe('TemplateCatalog')` (M46 R6): the form is the
 * same form with the same testids, so its cases are the same cases -- only the file they live in
 * changed, with the component.
 */
describe('the creation form', () => {
  async function waitForModelSelect(): Promise<HTMLSelectElement> {
    return waitFor(() => {
      const select = screen.getByTestId('model-select') as HTMLSelectElement
      expect(select.disabled).toBe(false)
      return select
    })
  }

  async function typeTemplateModel(value: string, providerId: ProviderKind = 'claude_code'): Promise<void> {
    fireEvent.change(screen.getByTestId('template-default-provider-select'), { target: { value: providerId } })
    await waitForModelSelect()
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: '__other__' } })
    fireEvent.change(screen.getByTestId('template-default-model-input'), { target: { value } })
  }

  beforeEach(() => {
    clearModelSelectCache()
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/providers/')) {
        return new Response(JSON.stringify({ models: [{ id: 'opus', label: 'opus' }], source: 'static' }), {
          status: 200,
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('posts the filled fields and refreshes on 200', async () => {
    render(<TemplateForm />)
    fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
    fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })
    fireEvent.change(screen.getByLabelText('template description'), { target: { value: 'ships UI' } })
    await typeTemplateModel('claude-opus-4')

    await act(async () => {
      fireEvent.click(screen.getByTestId('template-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Frontend Engineer',
          role: 'frontend',
          description: 'ships UI',
          defaultModel: 'claude-opus-4',
          defaultProvider: 'claude_code',
        }),
      }),
    )
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('omits description/defaultModel when left blank', async () => {
    render(<TemplateForm />)
    fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
    fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('template-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates',
      expect.objectContaining({ body: JSON.stringify({ name: 'Frontend Engineer', role: 'frontend' }) }),
    )
  })

  it('shows a duplicate-name 409 refusal inline without refreshing', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: 'the name "Backend Engineer" is already taken' }), { status: 409 }),
    )
    render(<TemplateForm />)
    fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Backend Engineer' } })
    fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'backend' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('template-submit'))
    })

    expect(screen.getByRole('alert').textContent).toContain('the name "Backend Engineer" is already taken')
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('includes defaultProvider alongside defaultModel when both are filled in', async () => {
    render(<TemplateForm />)
    fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
    fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })
    await typeTemplateModel('claude-opus-4', 'cursor')

    await act(async () => {
      fireEvent.click(screen.getByTestId('template-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'Frontend Engineer',
          role: 'frontend',
          defaultModel: 'claude-opus-4',
          defaultProvider: 'cursor',
        }),
      }),
    )
  })

  it('omits defaultProvider when no defaultModel is given, even if a provider is selected', async () => {
    render(<TemplateForm />)
    fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
    fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })
    fireEvent.change(screen.getByLabelText('template default provider'), { target: { value: 'cursor' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('template-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates',
      expect.objectContaining({ body: JSON.stringify({ name: 'Frontend Engineer', role: 'frontend' }) }),
    )
  })

  it('shows the model-without-provider refusal text verbatim', async () => {
    render(<TemplateForm />)
    fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
    fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })
    await typeTemplateModel('claude-opus-4')
    fireEvent.change(screen.getByTestId('template-default-provider-select'), { target: { value: '' } })
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: 'a model must name the provider that runs it' }), { status: 409 }),
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('template-submit'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a model must name the provider that runs it')
    expect(routerRefresh).not.toHaveBeenCalled()
  })
})
