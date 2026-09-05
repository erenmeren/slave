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
    counts: { slavesWorking: 0, tasksActive: 2 },
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

  // Ported from `TopBar`'s own mock-geometry cases (base `test/shell.test.tsx`; M24 final review,
  // Important 5b) -- lost in the move to `ProjectHeader`.
  it('keeps the structural hairline under the gradient one, as the mock does', () => {
    // `Slave of AI Web.dc.html:32-33`: the bar has BOTH a `border-bottom` and the gradient
    // element at `bottom:-1px`, beneath it.
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    expect(screen.getByTestId('project-header').className).toContain('border-b')
    expect(screen.getByTestId('project-header').className).toContain('border-line')
    expect(screen.getByTestId('project-header-hairline').className).toContain('-bottom-px')
  })

  it('gives the connection chip the mockup pill shape in the live status colour', () => {
    // `Slave of AI Web.dc.html:38-41`: `padding:3px 9px`, `border-radius:20px`, border
    // `rgba(46,230,207,.25)`, background `rgba(46,230,207,.06)`, `500 10px` mono `#2ee6cf`, 5px dot.
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    act(() => publishStreamState('w1', { connection: 'connected', latencyMs: 42 }))
    const chip = screen.getByTestId('connection')
    expect(chip.className).toContain('rounded-pill')
    expect(chip.className).toContain('px-[9px]')
    expect(chip.className).toContain('py-[3px]')
    expect(chip.className).toContain('text-[10px]')
    expect(chip.className).toContain('border-tone-working/25')
    expect(chip.className).toContain('bg-tone-working/[0.06]')
    expect(chip.className).toContain('text-tone-working')
    expect(chip.innerHTML).toContain('h-[5px]')
  })

  it('draws the budget bar at the mockup geometry, with the glow in the threshold colour', () => {
    // `Slave of AI Web.dc.html:47`: track `width:150px; height:3px; border-radius:2px;
    // background:rgba(255,255,255,.08)`, fill `box-shadow:0 0 8px <colour>`.
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    const html = screen.getByTestId('budget').innerHTML
    expect(html).toContain('w-[150px]')
    expect(html).toContain('h-[3px]')
    expect(html).toContain('rounded-[2px]')
    expect(html).toContain('bg-white/[0.08]')
    expect(html).toContain('shadow-[0_0_8px_var(--color-tone-working)]')
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

  // M24 final review, Important 2: nothing publishes a stream state on the Settings tab, and the
  // chip used to fall back to a live, pulsing "connected" look for a stream that does not exist.
  it('shows a neutral, non-pulsing chip when nothing has published a stream state', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    const connection = screen.getByTestId('connection')
    expect(connection.textContent).toBe('sse · —')
    expect(connection.className).not.toContain('bg-tone-working')
    expect(connection.innerHTML).not.toContain('animate-[status-pulse')
  })

  it('shows the live, pulsing chip once a stream publishes connected', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    act(() => publishStreamState('w1', { connection: 'connected', latencyMs: 12 }))
    const connection = screen.getByTestId('connection')
    expect(connection.textContent).toBe('sse · 12ms')
    expect(connection.className).toContain('bg-tone-working/[0.06]')
    expect(connection.innerHTML).toContain('animate-[status-pulse')
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
      counts: { slavesWorking: 0, tasksActive: 2 },
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
