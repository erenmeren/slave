// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellFacts } from '../src/server/shell'
import { publishShellFacts } from '../src/hooks/useShellFacts'
import { publishStreamState } from '../src/hooks/useStreamState'
import { ProjectHeader } from '../src/components/project/ProjectHeader'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => '/w/w1' }))

function facts(over: Partial<ShellFacts['status']> = {}): ShellFacts {
  return {
    workspace: { id: 'w1', name: 'Checkout Platform' },
    counts: { agentsWorking: 0, tasksActive: 2 },
    guardrails: { budgetUsd: 2, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 5 },
    status: { goal: null, spentUsd: 0.5, unmeasuredRuns: 0, haltedReason: null, ...over },
  }
}
const workspaces = [
  { id: 'w1', name: 'Checkout Platform' },
  { id: 'w2', name: 'Billing' },
]

afterEach(() => {
  publishShellFacts('w1', null)
  publishStreamState('w1', null)
})

describe('ProjectHeader', () => {
  it('is 52px tall and names the project, the goal state and the budget from the initial facts', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    expect(screen.getByTestId('project-header').className).toContain('h-[52px]')
    expect(screen.getByTestId('project-switcher').textContent).toContain('Checkout Platform')
    expect(screen.getByTestId('project-goal').textContent).toBe('no goal · set one')
    expect(screen.getByTestId('project-goal').closest('a')?.getAttribute('href')).toBe('/w/w1/settings')
    expect(screen.getByTestId('budget').textContent).toContain('$0.50 / $2.00')
    expect(screen.getByTestId('connection').textContent).toBe('sse · —')
  })

  it('shows the goal, truncated to one line, and links it to the Settings tab', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts({ goal: 'Ship rate limiting' })} workspaces={workspaces} />)
    const goal = screen.getByTestId('project-goal')
    expect(goal.textContent).toBe('Goal: Ship rate limiting')
    expect(goal.className).toContain('truncate')
    expect(goal.closest('a')?.getAttribute('href')).toBe('/w/w1/settings')
  })

  it('follows a later publication of facts and stream state', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    act(() => {
      publishShellFacts('w1', facts({ spentUsd: 1.75, unmeasuredRuns: 1, goal: 'Do it' }))
      publishStreamState('w1', { connection: 'connected', latencyMs: 42 })
    })
    expect(screen.getByTestId('budget').textContent).toContain('$1.75 / $2.00')
    expect(screen.getByTestId('budget-unmeasured').textContent).toBe('· 1 unmeasured')
    expect(screen.getByTestId('connection').textContent).toBe('sse · 42ms')
    expect(screen.getByTestId('project-goal').textContent).toBe('Goal: Do it')
  })

  it('says reconnecting in the warn tone when the stream drops', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    act(() => publishStreamState('w1', { connection: 'reconnecting', latencyMs: 42 }))
    expect(screen.getByTestId('connection').textContent).toBe('reconnecting')
    expect(screen.getByTestId('connection').className).toContain('text-tone-waiting')
  })

  it('renders the STOP button armed by the halt state', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts({ haltedReason: 'emergency stop by eren' })} workspaces={workspaces} />)
    expect((screen.getByTestId('emergency-stop') as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the switcher with every workspace and a New project row', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    fireEvent.click(screen.getByTestId('project-switcher'))
    const rows = screen.getAllByTestId('project-switcher-row')
    expect(rows.map((r) => r.textContent)).toEqual(['Checkout Platform', 'Billing'])
    expect(rows[0]?.getAttribute('aria-current')).toBe('true')
    expect(rows[1]?.getAttribute('href')).toBe('/w/w2')
    expect(screen.getByTestId('project-switcher-new').getAttribute('href')).toBe('/?new=1')
  })
})
