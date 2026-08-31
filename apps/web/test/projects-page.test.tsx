// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsClient } from '../src/components/ProjectsClient.js'
import type { ProjectRow } from '../src/server/org.js'

const routerRefresh = vi.fn()
const routerPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: routerPush }),
}))

function project(over: Partial<ProjectRow>): ProjectRow {
  return {
    id: 'w1',
    name: 'Checkout Platform',
    companyName: null,
    halted: false,
    taskCounts: { done: 2, total: 5, active: 1, blocked: 0 },
    workerCount: 3,
    spend: 12.5,
    unmeasuredRuns: 0,
    goal: null,
    team: [],
    ...over,
  }
}

const companies = [
  { id: 'c1', name: 'Acme Robotics' },
  { id: 'c2', name: 'Globex' },
]

describe('ProjectsClient', () => {
  afterEach(() => {
    routerRefresh.mockClear()
    routerPush.mockClear()
  })

  it('renders one card per project with its name, company badge, and a 4-up stat strip', () => {
    render(
      <ProjectsClient
        projects={[project({ id: 'w1', name: 'Checkout Platform', companyName: 'Acme Robotics' })]}
        companies={companies}
      />,
    )
    expect(screen.getByText('Checkout Platform')).toBeTruthy()
    expect(screen.getByText('Acme Robotics')).toBeTruthy()
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
      <ProjectsClient projects={[project({ id: 'w1', unmeasuredRuns: 2 })]} companies={companies} />,
    )
    expect(screen.getAllByTestId('stat-strip-item')).toHaveLength(4)
    const spendTile = screen.getAllByTestId('stat-strip-item')[3]
    expect(spendTile?.contains(screen.getByTestId('project-unmeasured'))).toBe(true)

    rerender(<ProjectsClient projects={[project({ id: 'w1', unmeasuredRuns: 0 })]} companies={companies} />)
    expect(screen.getAllByTestId('stat-strip-item')).toHaveLength(4)
    expect(screen.queryByTestId('project-unmeasured')).toBeNull()
  })

  it('shows a dim "no company" badge and an assign button when unassigned', () => {
    render(<ProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
    expect(screen.getByText('no company')).toBeTruthy()
    expect(screen.getByTestId('assign-company-button')).toBeTruthy()
  })

  it('does not show the assign button once a company is already assigned', () => {
    render(<ProjectsClient projects={[project({ id: 'w1', companyName: 'Acme Robotics' })]} companies={companies} />)
    expect(screen.queryByTestId('assign-company-button')).toBeNull()
  })

  it('maps halted -> blocked tone, active work -> working tone, otherwise idle', () => {
    const { rerender } = render(<ProjectsClient projects={[project({ id: 'w1', halted: true })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('blocked')

    rerender(
      <ProjectsClient
        projects={[project({ id: 'w1', halted: false, taskCounts: { done: 1, total: 4, active: 2, blocked: 0 } })]}
        companies={companies}
      />,
    )
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('working')

    rerender(
      <ProjectsClient
        projects={[project({ id: 'w1', halted: false, taskCounts: { done: 4, total: 4, active: 0, blocked: 0 } })]}
        companies={companies}
      />,
    )
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('idle')
  })

  it('navigates to the workspace when the card is clicked', () => {
    render(<ProjectsClient projects={[project({ id: 'w7', companyName: 'Acme Robotics' })]} companies={companies} />)
    fireEvent.click(screen.getByTestId('card'))
    expect(routerPush).toHaveBeenCalledWith('/w/w7')
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
      render(<ProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('assign-company-button'))
      fireEvent.click(screen.getByText('Globex'))

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
      render(<ProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('assign-company-button'))
      fireEvent.click(screen.getByText('Acme Robotics'))

      await act(async () => {
        fireEvent.click(screen.getByTestId('assign-confirm'))
      })

      expect(screen.getByRole('alert').textContent).toContain('this workspace is already run by Acme Robotics')
      expect(routerRefresh).not.toHaveBeenCalled()
      expect(screen.getByTestId('assign-confirm')).toBeTruthy()
    })

    it('moves focus into the dialog (the first company row) when it opens', () => {
      render(<ProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
      fireEvent.click(screen.getByTestId('assign-company-button'))

      expect(screen.getByTestId('assign-company-dialog').contains(document.activeElement)).toBe(true)
      expect(document.activeElement).toBe(screen.getAllByTestId('company-option')[0])
    })

    it('closes on Escape and returns focus to the trigger button', () => {
      render(<ProjectsClient projects={[project({ id: 'w1', companyName: null })]} companies={companies} />)
      const trigger = screen.getByTestId('assign-company-button')
      fireEvent.click(trigger)
      expect(screen.getByTestId('assign-company-dialog')).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(screen.queryByTestId('assign-company-dialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
  })
})

describe('the handoff project card', () => {
  it('shows the goal as the one-line description, and says so when there is none', () => {
    const { rerender } = render(<ProjectsClient projects={[project({ goal: 'Payments rewrite' })]} companies={companies} />)
    expect(screen.getByTestId('project-description').textContent).toBe('Payments rewrite')

    rerender(<ProjectsClient projects={[project({ goal: null })]} companies={companies} />)
    expect(screen.getByTestId('project-description').textContent).toBe('no goal set')
  })

  it('renders an avatar tile per team member instead of numbered placeholders', () => {
    render(
      <ProjectsClient
        projects={[project({ team: [{ agentId: 'a1', name: 'Alex Turner', status: 'working' }, { agentId: 'a2', name: 'Bea Ng', status: 'idle' }] })]}
        companies={companies}
      />,
    )
    expect(screen.getAllByTestId('avatar-tile').map((t) => t.textContent)).toEqual(['AT', 'BN'])
    expect(screen.getAllByTestId('avatar-tile')[0]?.getAttribute('data-tone')).toBe('working')
  })

  it('renders a 4-up stat strip: agents, active, blocked, spend', () => {
    render(<ProjectsClient projects={[project({})]} companies={companies} />)
    expect(screen.getAllByTestId('stat-strip-item').map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'agents 3', 'active 1', 'blocked 0', 'spend $12.50',
    ])
  })

  it('shows the unknown mark on spend rather than a total that swallows unmeasured runs', () => {
    render(<ProjectsClient projects={[project({ spend: 4, unmeasuredRuns: 2 })]} companies={companies} />)
    expect(screen.getByTestId('project-unmeasured').textContent).toBe('2 runs unmeasured')
    // Re-pointed by the M14 fix wave (queue item (f)): the caveat reads inside the tile it
    // qualifies now, so the tile's own text carries both halves.
    expect(screen.getAllByTestId('stat-strip-item')[3]?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'spend $4.00 2 runs unmeasured',
    )
  })

  // M14 fix wave, review I4: `projects.png` showed `AGENTS 0` above six avatar tiles on the same
  // card. The tile and the row read the same DTO's two halves; this pins that they agree.
  it('puts the same number in the AGENTS tile as it puts faces in the avatar row', () => {
    render(
      <ProjectsClient
        projects={[
          project({
            workerCount: 2,
            team: [{ agentId: 'a1', name: 'Alex Turner', status: 'working' }, { agentId: 'a2', name: 'Bea Ng', status: 'idle' }],
          }),
        ]}
        companies={companies}
      />,
    )
    expect(screen.getAllByTestId('stat-strip-item')[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('agents 2')
    expect(screen.getAllByTestId('avatar-tile')).toHaveLength(2)
  })

  it('maps halted to Halted, active work to Running, and quiet to Idle', () => {
    const { rerender } = render(<ProjectsClient projects={[project({ halted: true })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('HALTED')

    rerender(<ProjectsClient projects={[project({ halted: false, taskCounts: { done: 0, total: 3, active: 2, blocked: 0 } })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('RUNNING')

    rerender(<ProjectsClient projects={[project({ halted: false, taskCounts: { done: 3, total: 3, active: 0, blocked: 0 } })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('IDLE')
  })

  it('caps the avatar row at six and says how many more', () => {
    const team = [
      { agentId: 'a1', name: 'Alex Turner', status: 'working' },
      { agentId: 'a2', name: 'Bea Ng', status: 'idle' },
      { agentId: 'a3', name: 'Chen Lee', status: 'working' },
      { agentId: 'a4', name: 'Dana Fox', status: 'idle' },
      { agentId: 'a5', name: 'Eve Martin', status: 'working' },
      { agentId: 'a6', name: 'Frank Smith', status: 'idle' },
      { agentId: 'a7', name: 'Grace Johnson', status: 'working' },
      { agentId: 'a8', name: 'Henry Brown', status: 'idle' },
    ]
    render(<ProjectsClient projects={[project({ team })]} companies={companies} />)
    const teamRow = screen.getByLabelText('team')
    expect(within(teamRow).getAllByTestId('avatar-tile')).toHaveLength(6)
    const overflow = within(teamRow).getByTestId('team-overflow')
    expect(overflow.textContent).toBe('+2')
    expect(overflow.title).toContain('Grace Johnson')
  })

  it('renders no overflow tile at six or fewer', () => {
    const team = [
      { agentId: 'a1', name: 'Alex Turner', status: 'working' },
      { agentId: 'a2', name: 'Bea Ng', status: 'idle' },
      { agentId: 'a3', name: 'Chen Lee', status: 'working' },
      { agentId: 'a4', name: 'Dana Fox', status: 'idle' },
      { agentId: 'a5', name: 'Eve Martin', status: 'working' },
      { agentId: 'a6', name: 'Frank Smith', status: 'idle' },
    ]
    render(<ProjectsClient projects={[project({ team })]} companies={companies} />)
    expect(screen.queryByTestId('team-overflow')).toBeNull()
  })
})
