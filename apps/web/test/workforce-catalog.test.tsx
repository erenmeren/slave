// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderKind } from '@slave-of-ai/control'
import type { CatalogRowView, WorkforceCatalogView } from '../src/server/org.js'
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
    expertise: ['Load-bearing code'],
    recommendedSkills: ['writing-plans'],
    mappingQuality: 'full',
    overriddenFields: [],
    rawOverride: false,
    ...over,
  }
}

const view = (rows: readonly CatalogRowView[]): WorkforceCatalogView => ({
  rows,
  facets: {
    divisions: ['engineering', 'testing'],
    capabilities: ['Design the module boundary', 'Run the work back'],
    skills: ['writing-plans'],
  },
})

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

describe('WorkforceCatalog rows', () => {
  it('renders a row per template: name, summary, three capability chips and a +N', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    const line = screen.getByTestId('catalog-row-t1')
    expect(within(line).getByText('Core Builder')).toBeTruthy()
    expect(line.textContent).toContain('Builds the core module and the tests that hold it up.')
    expect(within(line).getAllByTestId('catalog-capability-chip')).toHaveLength(3)
    expect(within(line).getByTestId('catalog-capability-more').textContent).toBe('+1')
  })

  // E13: `gate:m11-shell` stage 1 fills the form below and then waits for a `data-table-row`
  // carrying the new template's name. The catalog's own handles are ADDITIONAL, never a rename.
  it('keeps the data-table primitives the m11 gate drives, under the catalog handle', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    expect(screen.getByTestId('workforce-catalog')).toBeTruthy()
    expect(screen.getByTestId('data-table')).toBeTruthy()
    expect(within(screen.getByTestId('catalog-row-t1')).getByTestId('data-table-row')).toBeTruthy()
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

  // Fix round 1, minor 4: every `Row` is the only child of its wrapper, so `Row`'s own
  // `last:border-b-0` matched ALL of them and the table drew no separator anywhere. The final
  // wave (I1) found the first fix still shipped `last:border-b-0` on the non-last rows -- and a
  // `:last-child` rule of higher specificity than `.border-b` still won on every wrapped row, so
  // the separator was still missing. A row whose caller manages position carries NO `:last-child`
  // rule at all: the non-last rows get a plain `border-b`, the last one gets neither.
  it('draws a separator under every row but the last, with no :last-child rule to undo it', () => {
    render(<WorkforceCatalog initial={view([row(), row({ id: 't2' }), row({ id: 't3' })])} />)
    const classNames = screen.getAllByTestId('data-table-row').map((node) => node.className)
    expect(classNames.map((name) => name.includes('border-b'))).toEqual([true, true, false])
    expect(classNames.map((name) => name.includes('last:border-b-0'))).toEqual([false, false, false])
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

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'nothing' } })
    })

    await waitFor(() => expect(screen.getByTestId('catalog-stale')).toBeTruthy())
    expect(screen.getByTestId('catalog-row-t1')).toBeTruthy()
  })
})

describe('WorkforceCatalog filters', () => {
  it('fetches the filtered catalog and writes the search into the URL without a router push', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'builder' } })
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog?q=builder'))
    expect(replaceState).toHaveBeenCalledWith(null, '', '/workforce?q=builder')
    expect(routerRefresh).not.toHaveBeenCalled()
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

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'buil' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'builder' } })
    })
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

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'buil' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'builder' } })
    })
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

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'builder' } })
    })

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

  const openDrawer = async (over: Partial<typeof withEffective> = {}): Promise<void> => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/profile')
        ? new Response(JSON.stringify({ ...withEffective, ...over }), { status: 200 })
        : new Response(JSON.stringify(view([row()])), { status: 200 }),
    )
    render(<WorkforceCatalog initial={view([row()])} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-row-t1'))
    })
    await waitFor(() => expect(screen.getByTestId('profile-drawer')).toBeTruthy())
  }

  it('opens on a row and shows every field group with its label', async () => {
    await openDrawer()

    expect(screen.getByTestId('profile-drawer-title').textContent).toBe('Core Builder')
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
