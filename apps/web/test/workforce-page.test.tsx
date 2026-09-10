// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkforceClient, type WorkforceTab } from '../src/components/workforce/WorkforceClient.js'
import type { AllSlaveRow, AllSlavesPage } from '../src/server/org.js'
import type { SkillsPage } from '../src/server/skills.js'

const routerRefresh = vi.fn()
const routerReplace = vi.fn()
let search = ''

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(search),
}))

function slaveRow(over: Partial<AllSlaveRow> = {}): AllSlaveRow {
  return {
    slaveId: 'a1',
    companySlaveId: null,
    name: 'Alex',
    role: 'backend',
    departmentName: 'Engineering',
    projectName: 'Checkout',
    workspaceId: 'w1',
    teamId: 't1',
    companyId: null,
    companyTeamId: null,
    status: 'working',
    currentTask: { title: 'Add the thing', pct: 40 },
    provider: null,
    gate: null,
    model: null,
    costUsd: 0,
    unmeasuredRuns: 0,
    runCount: 0,
    runtimeRoles: ['backend'],
    ...over,
  }
}

function page(rows: readonly AllSlaveRow[]): AllSlavesPage {
  return {
    rows,
    departmentsByWorkspace: { w1: [{ id: 't1', name: 'Engineering' }, { id: 't2', name: 'QA' }] },
    templatesByCompany: { c1: [{ id: 'ct1', name: 'Backend' }, { id: 'ct2', name: 'Design' }] },
  }
}

function skillsPage(over: Partial<SkillsPage> = {}): SkillsPage {
  return {
    providers: [
      {
        id: 'p1',
        name: 'plugin:superpowers',
        skills: [{ id: 's1', name: 'writing-plans', description: 'plans things', runs: 18, state: 'ready', slaveIds: [] }],
      },
    ],
    slaves: [{ id: 'a1', name: 'Alex Turner', status: 'working' }],
    scannedRoots: ['/home/x/.claude/skills'],
    ...over,
  }
}

/** Every prop `WorkforceClient` takes, defaulted to the empty shape, so a case states only what it
 *  is about. An explicit prop wins over the default (JSX prop order). */
type WorkforceProps = React.ComponentProps<typeof WorkforceClient>
function TestWorkforceClient(
  props: Partial<WorkforceProps> & { readonly initialTab?: WorkforceTab },
): React.JSX.Element {
  return (
    <WorkforceClient
      initialTab="slaves"
      slaves={page([slaveRow({})])}
      teams={[]}
      workspaces={[]}
      companies={[]}
      roster={[]}
      templates={[]}
      catalogImports={[]}
      skills={skillsPage()}
      {...props}
    />
  )
}

afterEach(() => {
  routerRefresh.mockClear()
  routerReplace.mockClear()
  search = ''
})

describe('WorkforceClient tabs (M44 R1)', () => {
  // The four surfaces the M44 audit found for "a slave" -- a sidebar row, another sidebar row, a
  // section on the Projects home and a panel inside a project -- are four tabs on one page now.
  it('renders the slaves table by default, with the other three tabs beside it', () => {
    render(<TestWorkforceClient />)
    expect(screen.getByTestId('data-table')).toBeTruthy()
    expect(screen.getByTestId('worker-row-button').textContent).toContain('Alex')
    expect(screen.getByTestId('workforce-tab-slaves').getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Slaves', 'Departments', 'Catalog', 'Skills'])
  })

  it('switches to the Departments tab and renders a DepartmentsTable row', () => {
    render(
      <TestWorkforceClient
        teams={[{ teamId: 't1', name: 'Platform', workspaceId: 'w1', projectName: 'Checkout', slaveCount: 2, runCount: 0 }]}
      />,
    )
    expect(screen.queryByTestId('department-rename')).toBeNull()

    fireEvent.click(screen.getByTestId('workforce-tab-departments'))

    expect(screen.getByTestId('workforce-tab-departments').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('department-rename').textContent).toBe('Platform')
  })

  // The team catalog that used to sit under the Projects page's cards (M24 T6), moved whole.
  it('renders the template catalog, the company manager and the import log on the Catalog tab', () => {
    render(<TestWorkforceClient />)
    expect(screen.queryByTestId('template-form')).toBeNull()

    fireEvent.click(screen.getByTestId('workforce-tab-catalog'))

    expect(screen.getByText('Template catalog')).toBeTruthy()
    expect(screen.getByText('Companies')).toBeTruthy()
    expect(screen.getByText('Catalog imports')).toBeTruthy()
    expect(screen.getByTestId('template-form')).toBeTruthy()
    expect(screen.getByTestId('company-form')).toBeTruthy()
    expect(screen.getByTestId('catalog-imports')).toBeTruthy()
  })

  it('renders the skills page itself on the Skills tab, and opens straight onto it from ?tab=skills', () => {
    render(<TestWorkforceClient initialTab="skills" />)
    expect(screen.getByTestId('workforce-tab-skills').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('skill-state-s1')).toBeTruthy()
    expect(screen.getByTestId('skill-provider')).toBeTruthy()
    expect(screen.getByTestId('provider-name-p1').textContent).toBe('plugin:superpowers')
  })

  // The tab is in the URL the way the Graph page keeps its mode: `/skills` redirects to a tab, and
  // a reload or a shared link keeps it. Written with `history.replaceState` (fix round 1) -- it
  // stacks no history entry a Back press has to walk through AND does not re-run the page's eight
  // loaders for a panel switch this component already made in local state. It MERGES into the
  // current query (ruling R13), so a link that arrived with another param keeps it.
  it('writes the chosen tab into ?tab= without a router round trip, keeping any other param', () => {
    search = 'from=nav'
    const replaceState = vi.spyOn(window.history, 'replaceState')
    render(<TestWorkforceClient />)
    fireEvent.click(screen.getByTestId('workforce-tab-catalog'))
    expect(replaceState).toHaveBeenCalledWith(null, '', '/workforce?from=nav&tab=catalog')
    expect(routerReplace).not.toHaveBeenCalled()
    replaceState.mockRestore()
  })

  // `+ New slave` opens the catalog form (M25 Task 8) and belongs to the Slaves tab alone: it
  // creates a slave, which is what that tab is about.
  it('opens the New slave drawer from the Slaves tab, and offers it on no other tab', () => {
    render(<TestWorkforceClient />)
    fireEvent.click(screen.getByTestId('new-slave'))
    expect(screen.getByRole('dialog', { name: /new slave/i })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('workforce-tab-skills'))
    expect(screen.queryByTestId('new-slave')).toBeNull()
  })
})

// MOVED from `slaves-page.test.tsx` unchanged in substance (M44 t3). From `WorkersTable`'s
// M11-era days: the row-click panel must resolve `workspaceId` off the clicked row itself, never
// by re-deriving from this component's own snapshot prop. `AllSlavesTable` (M24 Task 7) keeps
// that: `onOpen` hands back the CLICKED row's own ids straight out of the table's own state.
describe('WorkforceClient row click opens the panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("opens the panel using the clicked row's own slaveId/workspaceId, after its status has moved via the poll", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/org/workers') {
        return new Response(
          JSON.stringify({
            workers: [
              {
                slaveId: 'a1',
                name: 'Alex',
                role: 'backend',
                workspaceId: 'w1',
                projectName: 'Checkout',
                status: 'paused',
                currentTask: null,
                department: 'Engineering',
                provider: null,
                gate: null,
                tokens: null,
                costUsd: 0,
                unmeasuredRuns: 0,
                // M37 t4 fix round 1: carried by the real `GET /api/org/workers` payload
                // (`listWorkers`), and merged into the table's rows on every tick. Stated here for
                // the same reason `waitingFor` is stated in the overview literal below — this is a
                // fetch RESPONSE body TypeScript never checks, and the table renders `.length`.
                runtimeRoles: ['backend'],
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url === '/api/w/w1/overview') {
        return new Response(
          JSON.stringify({
            slaves: [
              {
                id: 'a1',
                name: 'Alex',
                role: 'backend',
                provider: null,
                gate: null,
                status: 'paused',
                taskTitle: null,
                taskId: null,
                taskStatus: null,
                progressPct: 0,
                stepLabel: null,
                skill: null,
                actionLine: null,
                runId: null,
                queuedMessage: null,
                resumeRequestedAt: null,
                recentEvents: [],
                costUsd: 0,
                toolCalls: 0,
                pausedAtStep: null,
                // M36 t2 added this to `SlaveCardData`, and the server sets it on every row
                // (`overview.ts`: a non-waiting run gets `null`). This literal is a fetch RESPONSE
                // body, so TypeScript never checks it -- without the field `SlavePanel` reads
                // `undefined`, which is not `null`, and crashes on `waitingFor.recipient`.
                waitingFor: null,
                // M37 t4 added these two; like `waitingFor` above they are stated because this
                // literal is a fetch RESPONSE body TypeScript never checks, and `SlavePanel` reads
                // `runtimeRoles.length` -- `undefined` there is a crash, not an empty set.
                profile: null,
                runtimeRoles: [],
              },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()

    render(<TestWorkforceClient slaves={page([slaveRow({ slaveId: 'a1', workspaceId: 'w1', name: 'Alex', status: 'working' })])} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('paused')

    vi.useRealTimers()
    fireEvent.click(screen.getByTestId('worker-row-button'))

    expect(await screen.findByRole('heading', { name: 'Alex' })).toBeTruthy()
  })

  /**
   * M44 final review, minor b. The panel's fetch had exactly one rendered outcome: the panel, or
   * nothing at all. A click on a row therefore looked identical while the request was in flight
   * and after it had FAILED -- an operator clicked a slave and the page did nothing, twice, for
   * two different reasons. `LoadingState` and `Alert` are the two primitives R3 minted for
   * precisely this, and this page had neither.
   */
  it('says the panel is loading while its fetch is in flight, and says so when it fails', async () => {
    let release: ((response: Response) => void) | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/org/workers') return new Response(JSON.stringify({ workers: [] }), { status: 200 })
      if (url === '/api/w/w1/overview') {
        return await new Promise<Response>((resolve) => {
          release = resolve
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<TestWorkforceClient slaves={page([slaveRow({ slaveId: 'a1', workspaceId: 'w1', name: 'Alex', status: 'working' })])} />)
    fireEvent.click(screen.getByTestId('worker-row-button'))

    expect(await screen.findByTestId('workforce-panel-loading')).toBeTruthy()
    expect(screen.getByTestId('workforce-panel-loading').getAttribute('role')).toBe('status')
    expect(screen.queryByTestId('workforce-panel-error')).toBeNull()

    await act(async () => {
      release?.(new Response('nope', { status: 500 }))
    })

    const alert = await screen.findByTestId('workforce-panel-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.getAttribute('data-variant')).toBe('error')
    expect(screen.queryByTestId('workforce-panel-loading')).toBeNull()
  })
})

// MOVED from `projects-page.test.tsx` (M44 t3): the catalog these assertions describe left the
// Projects home for the Workforce Catalog tab. M42 t4's subject is unchanged -- where an operator
// reads what an import did.
describe('the catalog import surfaces', () => {
  const imported = {
    id: 't2',
    name: 'Core Builder',
    role: 'engineering',
    description: 'Builds the core.',
    defaultModel: null,
    defaultProvider: null,
    catalogSlaveCount: 0,
    sourceId: 'catalog-m42/engineering/core-builder',
    sourceDivision: 'engineering',
    importedAt: '2026-09-10T08:30:00.000Z',
  }

  it('marks an imported template with its division and the date it arrived', () => {
    render(<TestWorkforceClient initialTab="catalog" templates={[imported]} />)

    const chip = screen.getByTestId('template-source-t2')
    expect(chip.textContent).toContain('engineering')
    expect(chip.textContent).toContain('2026-09-10')
  })

  it('shows no source chip on a hand-made template', () => {
    const handMade = { ...imported, id: 't1', name: 'Hand Made', sourceId: null, sourceDivision: null, importedAt: null }
    render(<TestWorkforceClient initialTab="catalog" templates={[handMade]} />)

    expect(screen.queryByTestId('template-source-t1')).toBeNull()
  })

  // Counts no other token in the row can produce: `2` was satisfied by the `2026` in the
  // timestamp and `4` by the `m42` in the catalog name, so both assertions passed with every
  // count span deleted (fix round 1, important 1). These four, in this order, can only come
  // from the four cells.
  it('lists the catalog imports with their counts, one cell per column', () => {
    render(
      <TestWorkforceClient
        initialTab="catalog"
        templates={[imported]}
        catalogImports={[
          { id: 'i1', catalog: 'catalog-m42', directory: '/srv/catalog-m42', by: 'operator', finishedAt: '2026-09-10T08:30:00.000Z', created: 17, updated: 5, unchanged: 23, skipped: 9 },
        ]}
      />,
    )

    const row = screen.getByTestId('catalog-import-i1')
    expect(row.textContent).toContain('catalog-m42')
    expect(row.textContent).toContain('operator')
    expect(row.textContent).toContain('2026-09-10 08:30:00')
    expect(within(row).getAllByTestId('catalog-import-count').map((cell) => cell.textContent)).toEqual([
      '17',
      '5',
      '23',
      '9',
    ])
  })

  it('says so when nothing has been imported', () => {
    render(<TestWorkforceClient initialTab="catalog" />)

    expect(screen.getByTestId('catalog-imports').textContent).toContain('no catalog has been imported yet')
  })
})
