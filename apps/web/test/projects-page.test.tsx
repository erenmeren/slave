// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsClient } from '../src/components/ProjectsClient.js'
import type { AnalyticsSnapshot } from '../src/server/analytics.js'
import type { ProjectRow } from '../src/server/org.js'

const routerRefresh = vi.fn()
const routerPush = vi.fn()
const routerReplace = vi.fn()
// Backs `useSearchParams` below -- reset per test so `?new=1` in one test can't leak the drawer
// open into the next (Step 1 brief).
let search = ''

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: routerPush, replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/',
}))

function project(over: Partial<ProjectRow>): ProjectRow {
  return {
    id: 'w1',
    name: 'Checkout Platform',
    companyName: null,
    halted: false,
    archived: false,
    taskCounts: { done: 2, total: 5, active: 1, blocked: 0 },
    workerCount: 3,
    spend: 12.5,
    unmeasuredRuns: 0,
    goal: null,
    team: [],
    needsYou: 0,
    ...over,
  }
}

const companies = [
  { id: 'c1', name: 'Acme Robotics' },
  { id: 'c2', name: 'Globex' },
]

const projects = [project({})]

// M44 t3: `templates`/`roster`/`catalogImports` are gone -- the team catalog they fed moved to
// Workforce -> Catalog, and its cases moved with it (`workforce-page.test.tsx`). What arrived in
// its place is `analytics`, the all-workspaces snapshot the KPI section renders; most of this
// file's cases only exercise the cards grid, so the wrapper defaults it to an empty snapshot and a
// case that cares overrides it (an explicit prop in `props` wins in JSX prop order).
const EMPTY_ANALYTICS: AnalyticsSnapshot = {
  workspaceId: null,
  seeded: false,
  series: [],
  kpis: [],
  perSlave: [],
}
type ProjectsClientProps = React.ComponentProps<typeof ProjectsClient>
function TestProjectsClient(
  props: Omit<ProjectsClientProps, 'analytics'> & Partial<Pick<ProjectsClientProps, 'analytics'>>,
): React.JSX.Element {
  return <ProjectsClient analytics={EMPTY_ANALYTICS} {...props} />
}

describe('ProjectsClient', () => {
  beforeEach(() => {
    search = ''
  })

  afterEach(() => {
    routerRefresh.mockClear()
    routerPush.mockClear()
    routerReplace.mockClear()
  })

  it('renders one card per project with its name, company badge, and a 4-up stat strip', () => {
    render(
      <TestProjectsClient
        projects={[project({ id: 'w1', name: 'Checkout Platform', companyName: 'Acme Robotics' })]}
        companies={companies}
      />,
    )
    // Scoped to the card: the team catalog below it (M24 T6) lists the same company names in
    // `CompanyManager`'s own list, so an unscoped `getByText` now matches twice.
    const card = screen.getByTestId('project-card')
    expect(within(card).getByText('Checkout Platform')).toBeTruthy()
    expect(within(card).getByText('Acme Robotics')).toBeTruthy()
    expect(screen.getAllByTestId('stat-strip-item')).toHaveLength(4)
  })

  it('shows the unmeasured line only when some of the project\'s runs reported no cost, never widening the strip', () => {
    // M12 Task 9 / ruling R3, applied to the sibling of the budget bar: `$12.50` presented alone
    // reads as this project's whole spend. It is only the measured part of it whenever any run
    // reported nothing. Task 13 (M14) moved this off the stat strip entirely; the M14 fix wave
    // (queue item (f)) moved it back INSIDE the spend tile as `StatStripItem.note`, which is
    // where `TopStrip` has always nested its own `strip-unmeasured`. Re-pointed to assert the
    // containment -- the strip is still a fixed 4-up, and the testid is unchanged.
    const { rerender } = render(
      <TestProjectsClient projects={[project({ id: 'w1', unmeasuredRuns: 2 })]} companies={companies} />,
    )
    expect(screen.getAllByTestId('stat-strip-item')).toHaveLength(4)
    const spendTile = screen.getAllByTestId('stat-strip-item')[3]
    expect(spendTile?.contains(screen.getByTestId('project-unmeasured'))).toBe(true)

    rerender(<TestProjectsClient projects={[project({ id: 'w1', unmeasuredRuns: 0 })]} companies={companies} />)
    expect(screen.getAllByTestId('stat-strip-item')).toHaveLength(4)
    expect(screen.queryByTestId('project-unmeasured')).toBeNull()
  })

  it('shows a dim "no company" badge and an assign button when unassigned', () => {
    render(<TestProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
    expect(screen.getByText('no company')).toBeTruthy()
    expect(screen.getByTestId('assign-company-button')).toBeTruthy()
  })

  it('does not show the assign button once a company is already assigned', () => {
    render(<TestProjectsClient projects={[project({ id: 'w1', companyName: 'Acme Robotics' })]} companies={companies} />)
    expect(screen.queryByTestId('assign-company-button')).toBeNull()
  })

  it('maps halted -> blocked tone, active work -> working tone, otherwise idle', () => {
    const { rerender } = render(<TestProjectsClient projects={[project({ id: 'w1', halted: true })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('blocked')

    rerender(
      <TestProjectsClient
        projects={[project({ id: 'w1', halted: false, taskCounts: { done: 1, total: 4, active: 2, blocked: 0 } })]}
        companies={companies}
      />,
    )
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('working')

    rerender(
      <TestProjectsClient
        projects={[project({ id: 'w1', halted: false, taskCounts: { done: 4, total: 4, active: 0, blocked: 0 } })]}
        companies={companies}
      />,
    )
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('idle')
  })

  it('navigates to the workspace when the card is clicked', () => {
    render(<TestProjectsClient projects={[project({ id: 'w7', companyName: 'Acme Robotics' })]} companies={companies} />)
    fireEvent.click(screen.getByTestId('card'))
    expect(routerPush).toHaveBeenCalledWith('/w/w7')
  })

  describe('show archived (M27 §3.4)', () => {
    it('is unchecked by default, and an archived card is absent', () => {
      render(<TestProjectsClient projects={[project({ id: 'w1', archived: false })]} companies={companies} />)
      expect((screen.getByTestId('show-archived') as HTMLInputElement).checked).toBe(false)
      expect(screen.queryByTestId('project-archived')).toBeNull()
    })

    it('is checked when ?archived=1, and an archived card shows the chip and a restore button', () => {
      search = 'archived=1'
      render(
        <TestProjectsClient
          projects={[project({ id: 'w1', archived: true })]}
          companies={companies}
        />,
      )
      expect((screen.getByTestId('show-archived') as HTMLInputElement).checked).toBe(true)
      expect(screen.getByTestId('project-archived').textContent).toBe('archived')
      expect(screen.getByTestId('restore-project')).toBeTruthy()
    })

    // Fix round 1, finding 1(a): the 4-up strip (`slaves`/`active`/`blocked`/`spend`) drops its
    // `spend` tile for an archived card -- spend is a live-budget figure an archived project no
    // longer accrues, per spec §3.4's "no spend bar". `stat-strip-item` at index 3 -- `spend` on
    // an active card (pinned by the "4-up stat strip" test above) -- must not exist here.
    it('drops the spend tile for an archived card (3-up, not 4-up)', () => {
      render(<TestProjectsClient projects={[project({ id: 'w1', archived: true, spend: 12.5 })]} companies={companies} />)
      const items = screen.getAllByTestId('stat-strip-item')
      expect(items).toHaveLength(3)
      expect(items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        'slaves 3', 'active 1', 'blocked 0',
      ])
      expect(screen.queryByText(/\$12\.50/)).toBeNull()
    })

    // Fix round 1, finding 1(b): `project()`'s default `companyName: null` is exactly the
    // combination that renders `assign-company-button` for an active card (the "shows a dim 'no
    // company' badge..." test above) -- an archived card must hide it regardless.
    it('hides assign-company-button on an archived card even with no company assigned', () => {
      render(<TestProjectsClient projects={[project({ id: 'w1', archived: true, companyName: null })]} companies={companies} />)
      expect(screen.queryByTestId('assign-company-button')).toBeNull()
      expect(screen.getByTestId('restore-project')).toBeTruthy()
    })

    it('checking it replaces the URL with ?archived=1', () => {
      render(<TestProjectsClient projects={[project({ id: 'w1' })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('show-archived'))
      expect(routerReplace).toHaveBeenCalledWith('/?archived=1')
    })

    it('unchecking it replaces the URL with no archived param', () => {
      search = 'archived=1'
      render(<TestProjectsClient projects={[project({ id: 'w1' })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('show-archived'))
      expect(routerReplace).toHaveBeenCalledWith('/')
    })

    // Fix round 1, finding 3 / ruling R13: the toggle must MERGE into the current query, not
    // replace the URL wholesale -- otherwise checking it from `?new=1` would silently close the
    // New project drawer's own param.
    it('checking it from another param merges rather than replacing (?new=1 -> ?new=1&archived=1)', () => {
      search = 'new=1'
      render(<TestProjectsClient projects={[project({ id: 'w1' })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('show-archived'))
      expect(routerReplace).toHaveBeenCalledWith('/?new=1&archived=1')
    })

    it('unchecking it keeps the other param (?new=1&archived=1 -> ?new=1)', () => {
      search = 'new=1&archived=1'
      render(<TestProjectsClient projects={[project({ id: 'w1' })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('show-archived'))
      expect(routerReplace).toHaveBeenCalledWith('/?new=1')
    })

    it('clicking restore-project POSTs /api/w/w1/restore and refreshes', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      search = 'archived=1'
      render(<TestProjectsClient projects={[project({ id: 'w1', archived: true })]} companies={companies} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('restore-project'))
      })

      expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/restore', expect.objectContaining({ method: 'POST' }))
      expect(routerRefresh).toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    // Fix round 1, finding 2: only the success path was covered -- a refusal must show inline
    // (the Settings-page danger zone's `restore-project-error` idiom) rather than silently
    // refreshing.
    it('shows a restore refusal in restore-project-error, without refreshing', async () => {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ error: 'project w1 is not archived' }), { status: 409 }),
      )
      vi.stubGlobal('fetch', fetchMock)
      search = 'archived=1'
      render(<TestProjectsClient projects={[project({ id: 'w1', archived: true })]} companies={companies} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('restore-project'))
      })

      expect(screen.getByTestId('restore-project-error').textContent).toBe('project w1 is not archived')
      expect(routerRefresh).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })
  })

  describe('assign company dialog', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('opens from the assign button and posts the chosen companyId, refreshing on ok', async () => {
      render(<TestProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('assign-company-button'))
      // Scoped to the dialog: the team catalog below the cards (M24 T6) lists the same company
      // names in `CompanyManager`'s own list, so an unscoped `getByText` now matches twice.
      fireEvent.click(within(screen.getByTestId('assign-company-dialog')).getByText('Globex'))

      await act(async () => {
        fireEvent.click(screen.getByTestId('assign-confirm'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/company',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'c2' }) }),
      )
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('shows the refusal text inline on a 409 without refreshing, and the dialog stays open', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'this workspace is already run by Acme Robotics' }), { status: 409 }),
      )
      render(<TestProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('assign-company-button'))
      fireEvent.click(within(screen.getByTestId('assign-company-dialog')).getByText('Acme Robotics'))

      await act(async () => {
        fireEvent.click(screen.getByTestId('assign-confirm'))
      })

      expect(screen.getByRole('alert').textContent).toContain('this workspace is already run by Acme Robotics')
      expect(routerRefresh).not.toHaveBeenCalled()
      expect(screen.getByTestId('assign-confirm')).toBeTruthy()
    })

    it('moves focus into the dialog (the first company row) when it opens', () => {
      render(<TestProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('assign-company-button'))

      expect(screen.getByTestId('assign-company-dialog').contains(document.activeElement)).toBe(true)
      expect(document.activeElement).toBe(screen.getAllByTestId('company-option')[0])
    })

    it('closes on Escape and returns focus to the trigger button', () => {
      render(<TestProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
      const trigger = screen.getByTestId('assign-company-button')
      fireEvent.click(trigger)
      expect(screen.getByTestId('assign-company-dialog')).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(screen.queryByTestId('assign-company-dialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
  })

  describe('the New project drawer and team catalog (M24 T6)', () => {
    it('has a New project button that opens the attach-a-repo drawer', () => {
      render(<TestProjectsClient projects={projects} companies={companies} />)
      expect(screen.queryByTestId('create-workspace-form')).toBeNull()
      fireEvent.click(screen.getByTestId('new-project'))
      expect(screen.getByRole('dialog', { name: /new project/i })).toBeTruthy()
      expect(screen.getByTestId('create-workspace-form')).toBeTruthy()
    })

    it('opens the drawer on load when ?new=1 is in the URL', () => {
      search = 'new=1'
      render(<TestProjectsClient projects={projects} companies={companies} />)
      expect(screen.getByTestId('create-workspace-form')).toBeTruthy()
    })

    // Ruled minor (M24 final review): a reload after closing the drawer must not reopen it.
    it('clears ?new=1 on close so a reload does not reopen the drawer', () => {
      search = 'new=1'
      render(<TestProjectsClient projects={projects} companies={companies} />)
      fireEvent.click(screen.getByTestId('new-project-close'))
      expect(routerReplace).toHaveBeenCalledWith('/')
    })

    // R13's shape again (M27 final review, parked): closing the drawer drops `new` but must keep
    // every other param -- `?new=1&archived=1` closes to `?archived=1`, not to `/`.
    it('clears ?new=1 on close without dropping ?archived=1', () => {
      search = 'new=1&archived=1'
      render(<TestProjectsClient projects={projects} companies={companies} />)
      fireEvent.click(screen.getByTestId('new-project-close'))
      expect(routerReplace).toHaveBeenCalledWith('/?archived=1')
    })

    it('does not touch the URL closing the drawer when it was opened by the button, not the param', () => {
      render(<TestProjectsClient projects={projects} companies={companies} />)
      fireEvent.click(screen.getByTestId('new-project'))
      fireEvent.click(screen.getByTestId('new-project-close'))
      expect(routerReplace).not.toHaveBeenCalled()
    })

    it('closes the drawer on Escape and on the close button', () => {
      render(<TestProjectsClient projects={projects} companies={companies} />)

      fireEvent.click(screen.getByTestId('new-project'))
      expect(screen.getByRole('dialog', { name: /new project/i })).toBeTruthy()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: /new project/i })).toBeNull()

      fireEvent.click(screen.getByTestId('new-project'))
      expect(screen.getByRole('dialog', { name: /new project/i })).toBeTruthy()
      fireEvent.click(screen.getByTestId('new-project-close'))
      expect(screen.queryByRole('dialog', { name: /new project/i })).toBeNull()
    })

    // M44 t3 (R1/E20): the team catalog left this page for Workforce -> Catalog, and the
    // all-workspaces KPI strip arrived from `/analytics` in its place -- the one section on this
    // page that is not about a single project. `/analytics` keeps its route and its link.
    it('renders the all-workspaces analytics section where the team catalog used to be', () => {
      render(
        <TestProjectsClient
          projects={projects}
          companies={companies}
          analytics={{
            ...EMPTY_ANALYTICS,
            kpis: [
              { label: 'tasks done', value: '42', note: null },
              { label: 'success', value: '92%', note: null },
              { label: 'avg', value: '14m 20s', note: null },
              { label: 'tokens', value: '1.2M', note: null },
              { label: 'spend', value: '$8.43', note: '3 runs unmeasured' },
              { label: 'slaves', value: '7', note: null },
            ],
          }}
        />,
      )
      expect(screen.queryByTestId('team-catalog')).toBeNull()
      expect(screen.queryByTestId('template-form')).toBeNull()
      expect(screen.queryByTestId('company-form')).toBeNull()
      expect(screen.getByTestId('all-projects-analytics')).toBeTruthy()
      expect(screen.getByTestId('kpi-strip')).toBeTruthy()
      expect(screen.getAllByTestId('kpi-tile')).toHaveLength(6)
      expect(screen.getByTestId('kpi-note-spend').textContent).toBe('3 runs unmeasured')
      expect(screen.getByRole('link', { name: /all/ }).getAttribute('href')).toBe('/analytics')
    })
  })
})

describe('the handoff project card', () => {
  it('shows the goal as the one-line description, and says so when there is none', () => {
    const { rerender } = render(<TestProjectsClient projects={[project({ goal: 'Payments rewrite' })]} companies={companies} />)
    expect(screen.getByTestId('project-description').textContent).toBe('Payments rewrite')

    rerender(<TestProjectsClient projects={[project({ goal: null })]} companies={companies} />)
    expect(screen.getByTestId('project-description').textContent).toBe('no goal set')
  })

  it('renders an avatar tile per team member instead of numbered placeholders', () => {
    render(
      <TestProjectsClient
        projects={[project({ team: [{ slaveId: 'a1', name: 'Alex Turner', status: 'working' }, { slaveId: 'a2', name: 'Bea Ng', status: 'idle' }] })]}
        companies={companies}
      />,
    )
    expect(screen.getAllByTestId('avatar-tile').map((t) => t.textContent)).toEqual(['AT', 'BN'])
    expect(screen.getAllByTestId('avatar-tile')[0]?.getAttribute('data-tone')).toBe('working')
  })

  it('renders a 4-up stat strip: slaves, active, blocked, spend', () => {
    render(<TestProjectsClient projects={[project({})]} companies={companies} />)
    expect(screen.getAllByTestId('stat-strip-item').map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'slaves 3', 'active 1', 'blocked 0', 'spend $12.50',
    ])
  })

  it('shows the unknown mark on spend rather than a total that swallows unmeasured runs', () => {
    render(<TestProjectsClient projects={[project({ spend: 4, unmeasuredRuns: 2 })]} companies={companies} />)
    expect(screen.getByTestId('project-unmeasured').textContent).toBe('2 runs unmeasured')
    // Re-pointed by the M14 fix wave (queue item (f)): the caveat reads inside the tile it
    // qualifies now, so the tile's own text carries both halves.
    expect(screen.getAllByTestId('stat-strip-item')[3]?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'spend $4.00 2 runs unmeasured',
    )
  })

  // M14 fix wave, review I4: `projects.png` showed `SLAVES 0` above six avatar tiles on the same
  // card. The tile and the row read the same DTO's two halves; this pins that they agree.
  it('puts the same number in the SLAVES tile as it puts faces in the avatar row', () => {
    render(
      <TestProjectsClient
        projects={[
          project({
            workerCount: 2,
            team: [{ slaveId: 'a1', name: 'Alex Turner', status: 'working' }, { slaveId: 'a2', name: 'Bea Ng', status: 'idle' }],
          }),
        ]}
        companies={companies}
      />,
    )
    expect(screen.getAllByTestId('stat-strip-item')[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('slaves 2')
    expect(screen.getAllByTestId('avatar-tile')).toHaveLength(2)
  })

  // M44 t3 (R4): the card's word comes from `userWorkspaceStatus` now, not from a table this file
  // owned -- RUNNING became WORKING (the product says one word for "work is happening"), and
  // ARCHIVED and WAITING FOR YOU are two states the old three-member table could not say at all.
  it('reads its one word from the domain: archived, halted, needs-you, working, idle', () => {
    const { rerender } = render(<TestProjectsClient projects={[project({ archived: true, halted: true })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('ARCHIVED')

    rerender(<TestProjectsClient projects={[project({ halted: true })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('HALTED')

    rerender(<TestProjectsClient projects={[project({ needsYou: 2, taskCounts: { done: 0, total: 3, active: 2, blocked: 2 } })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('WAITING FOR YOU')

    rerender(<TestProjectsClient projects={[project({ halted: false, taskCounts: { done: 0, total: 3, active: 2, blocked: 0 } })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')

    rerender(<TestProjectsClient projects={[project({ halted: false, taskCounts: { done: 3, total: 3, active: 0, blocked: 0 } })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('IDLE')
  })

  // The count itself, under the goal line -- the number `docs/ia.md` is careful to call a floor.
  it('says how many things need a person, singular and plural, and says nothing at zero', () => {
    const { rerender } = render(<TestProjectsClient projects={[project({ needsYou: 0 })]} companies={companies} />)
    expect(screen.queryByTestId('project-needs-you')).toBeNull()

    rerender(<TestProjectsClient projects={[project({ needsYou: 1 })]} companies={companies} />)
    expect(screen.getByTestId('project-needs-you').textContent).toBe('1 thing needs you')

    rerender(<TestProjectsClient projects={[project({ needsYou: 3 })]} companies={companies} />)
    expect(screen.getByTestId('project-needs-you').textContent).toBe('3 things need you')
  })

  it('caps the avatar row at six and says how many more', () => {
    const team = [
      { slaveId: 'a1', name: 'Alex Turner', status: 'working' },
      { slaveId: 'a2', name: 'Bea Ng', status: 'idle' },
      { slaveId: 'a3', name: 'Chen Lee', status: 'working' },
      { slaveId: 'a4', name: 'Dana Fox', status: 'idle' },
      { slaveId: 'a5', name: 'Eve Martin', status: 'working' },
      { slaveId: 'a6', name: 'Frank Smith', status: 'idle' },
      { slaveId: 'a7', name: 'Grace Johnson', status: 'working' },
      { slaveId: 'a8', name: 'Henry Brown', status: 'idle' },
    ]
    render(<TestProjectsClient projects={[project({ team })]} companies={companies} />)
    const teamRow = screen.getByLabelText('team')
    expect(within(teamRow).getAllByTestId('avatar-tile')).toHaveLength(6)
    const overflow = within(teamRow).getByTestId('team-overflow')
    expect(overflow.textContent).toBe('+2')
    expect(overflow.title).toContain('Grace Johnson')
  })

  it('renders no overflow tile at six or fewer', () => {
    const team = [
      { slaveId: 'a1', name: 'Alex Turner', status: 'working' },
      { slaveId: 'a2', name: 'Bea Ng', status: 'idle' },
      { slaveId: 'a3', name: 'Chen Lee', status: 'working' },
      { slaveId: 'a4', name: 'Dana Fox', status: 'idle' },
      { slaveId: 'a5', name: 'Eve Martin', status: 'working' },
      { slaveId: 'a6', name: 'Frank Smith', status: 'idle' },
    ]
    render(<TestProjectsClient projects={[project({ team })]} companies={companies} />)
    expect(screen.queryByTestId('team-overflow')).toBeNull()
  })
})
