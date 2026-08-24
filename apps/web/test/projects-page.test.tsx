// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
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
  })
})
