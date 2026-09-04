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

describe('ProjectHeader budget bar (M24 §2.2)', () => {
  function withBudget(spentUsd: number, budgetUsd: number | null, unmeasuredRuns = 0): ShellFacts {
    return {
      workspace: { id: 'w1', name: 'Checkout Platform' },
      counts: { agentsWorking: 0, tasksActive: 2 },
      guardrails: { budgetUsd, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 5 },
      status: { goal: null, spentUsd, unmeasuredRuns, haltedReason: null },
    }
  }

  it('turns the budget bar amber past 80% and red past 100%', () => {
    const { rerender } = render(<ProjectHeader workspaceId="w1" initial={withBudget(85, 100)} workspaces={workspaces} />)
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-tone-waiting')
    rerender(<ProjectHeader workspaceId="w1" initial={withBudget(101, 100)} workspaces={workspaces} />)
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-tone-blocked')
  })

  it('says how many runs went unmeasured, so known spend is not read as total spend', () => {
    // M12 Task 9 / ruling R11. `$3.20 / $20.00` on its own claims to be the whole bill. With two
    // runs nobody could measure, it is only the part of the bill that was measured -- and this is
    // the highest-visibility surface in the product for that distinction to be missing from.
    render(<ProjectHeader workspaceId="w1" initial={withBudget(3.2, 20, 2)} workspaces={workspaces} />)
    const budget = screen.getByTestId('budget')
    expect(budget.textContent).toContain('$3.20')
    expect(budget.textContent).toContain('$20.00')
    expect(budget.textContent).toContain('2 unmeasured')
  })

  it('says nothing about unmeasured runs when there are none', () => {
    render(<ProjectHeader workspaceId="w1" initial={withBudget(3.2, 20, 0)} workspaces={workspaces} />)
    expect(screen.getByTestId('budget').textContent).not.toContain('unmeasured')
  })

  it('shows the known spend with no ratio and no bar when the workspace has no budget', () => {
    // M12 Task 9 / ruling R11. `guardrails.budgetUsd: null` means this workspace is not budgeted
    // at all -- spec §6's only state in which a cost-blind runtime may run there. There is no
    // ceiling to draw a ratio against, so showing one would be inventing a limit nobody set.
    render(<ProjectHeader workspaceId="w1" initial={withBudget(3.2, null, 0)} workspaces={workspaces} />)
    const budget = screen.getByTestId('budget')
    expect(budget.textContent).toContain('$3.20')
    expect(budget.textContent).not.toContain('/')
    expect(budget.innerHTML).not.toContain('bg-tone-working')
    expect(budget.innerHTML).not.toContain('bg-tone-waiting')
    expect(budget.innerHTML).not.toContain('bg-tone-blocked')
  })
})
