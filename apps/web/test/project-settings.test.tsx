// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSettings } from '../src/server/projectSettings.js'
import type { ShellFacts } from '../src/server/shell.js'
import { GoalPanel } from '../src/components/project/GoalPanel.js'
import { ProjectSettingsClient } from '../src/components/project/ProjectSettingsClient.js'
import { RuntimePanel } from '../src/components/project/RuntimePanel.js'
import { publishShellFacts } from '../src/hooks/useShellFacts.js'
import { postControl, sendControl } from '../src/lib/postControl.js'

const refresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

vi.mock('../src/lib/postControl.js', () => ({
  postControl: vi.fn(async () => ({ ok: true as const })),
  sendControl: vi.fn(async (): Promise<string | null> => null),
}))

vi.mock('../src/hooks/useShellFacts.js', () => ({ publishShellFacts: vi.fn() }))

afterEach(() => {
  vi.clearAllMocks()
})

describe('GoalPanel', () => {
  it('renders the form when goal is null', () => {
    render(<GoalPanel workspaceId="w1" goal={null} />)
    expect(screen.getByRole('textbox', { name: 'workspace goal' })).toBeTruthy()
    expect(screen.getByTestId('goal-submit')).toBeTruthy()
    expect(screen.queryByTestId('workspace-goal')).toBeNull()
  })

  it('posts /api/w/w1/goal with the typed text', async () => {
    render(<GoalPanel workspaceId="w1" goal={null} />)
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: 'ship the redesign' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(postControl).toHaveBeenCalledWith('/api/w/w1/goal', { goal: 'ship the redesign' })
  })

  it('renders the goal read-only when set', () => {
    render(<GoalPanel workspaceId="w1" goal="ship the redesign" />)
    expect(screen.getByTestId('workspace-goal').textContent).toBe('ship the redesign')
    expect(screen.queryByTestId('goal-input')).toBeNull()
  })

  it('a 409 lands in the alert span', async () => {
    vi.mocked(postControl).mockResolvedValueOnce({ ok: false, error: 'a goal must be a non-empty text' })
    render(<GoalPanel workspaceId="w1" goal={null} />)
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: '  ' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a goal must be a non-empty text')
    // Success clears nothing locally; a failed submit stays in form mode too.
    expect(screen.getByTestId('goal-input')).toBeTruthy()
  })

  it('an edit button switches a set goal back to the form, seeded with the current goal', () => {
    render(<GoalPanel workspaceId="w1" goal="ship checkout" />)
    expect(screen.queryByTestId('goal-input')).toBeNull()

    fireEvent.click(screen.getByTestId('goal-edit'))

    expect((screen.getByTestId('goal-input') as HTMLInputElement).value).toBe('ship checkout')
    expect(screen.queryByTestId('workspace-goal')).toBeNull()
  })
})

describe('RuntimePanel', () => {
  const limits = { maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 5 }

  it('PUTs the chosen provider', async (): Promise<void> => {
    render(<RuntimePanel workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} limits={limits} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace provider'), { target: { value: 'cursor' } })
      fireEvent.click(screen.getByTestId('runtime-provider-submit'))
    })

    expect(sendControl).toHaveBeenCalledWith('/api/w/w1/provider', { method: 'PUT', body: { provider: 'cursor' } })
  })

  it('sends an explicit null when the operator picks (none)', async (): Promise<void> => {
    render(<RuntimePanel workspaceId="w1" provider="cursor" budgetUsd={null} costBlindBudgeted={false} limits={limits} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace provider'), { target: { value: '' } })
      fireEvent.click(screen.getByTestId('runtime-provider-submit'))
    })

    expect(sendControl).toHaveBeenCalledWith('/api/w/w1/provider', { method: 'PUT', body: { provider: null } })
  })

  it('PUTs the typed budget', async (): Promise<void> => {
    render(<RuntimePanel workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} limits={limits} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace budget'), { target: { value: '35.5' } })
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })

    expect(sendControl).toHaveBeenCalledWith('/api/w/w1/budget', { method: 'PUT', body: { budgetUsd: 35.5 } })
  })

  it('submits a budget of zero as the number zero, never as null', async (): Promise<void> => {
    // Decision 11's edge: `0` is a real ceiling ("this workspace may spend nothing"), and a panel
    // that coalesced it to null would silently turn the strictest budget into no budget at all.
    render(<RuntimePanel workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} limits={limits} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace budget'), { target: { value: '0' } })
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })

    expect(sendControl).toHaveBeenCalledWith('/api/w/w1/budget', { method: 'PUT', body: { budgetUsd: 0 } })
  })

  it('the not-budgeted checkbox disables the input and submits null', async (): Promise<void> => {
    render(<RuntimePanel workspaceId="w1" provider="cursor" budgetUsd={20} costBlindBudgeted={true} limits={limits} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('not budgeted'))
    })
    // `getAttribute('disabled')` rather than jest-dom's `toBeDisabled` -- this repo's vitest
    // setup carries no jest-dom matchers.
    expect((screen.getByLabelText('workspace budget') as HTMLInputElement).disabled).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })
    expect(sendControl).toHaveBeenCalledWith('/api/w/w1/budget', { method: 'PUT', body: { budgetUsd: null } })
  })

  it('a 409 keeps the operator input and shows the refusal verbatim', async (): Promise<void> => {
    vi.mocked(sendControl).mockResolvedValueOnce('a budget must be a non-negative amount or absent')
    render(<RuntimePanel workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} limits={limits} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('workspace budget'), { target: { value: '-3' } })
      fireEvent.click(screen.getByTestId('runtime-budget-submit'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a budget must be a non-negative amount or absent')
    // M11's idiom: a refused write keeps what the operator typed.
    expect((screen.getByLabelText('workspace budget') as HTMLInputElement).value).toBe('-3')
  })

  it('warns only for the cost-blind-and-budgeted combination', (): void => {
    const warning = /this provider reports no cost; a budgeted workspace will refuse it at dispatch/i
    const { rerender } = render(
      <RuntimePanel workspaceId="w1" provider="cursor" budgetUsd={20} costBlindBudgeted={true} limits={limits} />,
    )
    expect(screen.getByText(warning)).toBeTruthy()

    // Same cost-blind provider, no budget: nothing to warn about.
    rerender(<RuntimePanel workspaceId="w1" provider="cursor" budgetUsd={null} costBlindBudgeted={false} limits={limits} />)
    expect(screen.queryByText(warning)).toBeNull()

    // Budgeted, but on a runtime that reports cost.
    rerender(<RuntimePanel workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} limits={limits} />)
    expect(screen.queryByText(warning)).toBeNull()
  })

  it('shows the three limits read-only, in the sidebar\'s old format', () => {
    render(<RuntimePanel workspaceId="w1" provider="claude_code" budgetUsd={20} costBlindBudgeted={false} limits={limits} />)
    expect(screen.getByTestId('runtime-concurrency').textContent).toBe('3')
    expect(screen.getByTestId('runtime-timeout').textContent).toBe('30m')
    expect(screen.getByTestId('runtime-attempts').textContent).toBe('5')
  })
})

function shellFacts(over: Partial<ShellFacts['status']> = {}): ShellFacts {
  return {
    workspace: { id: 'w1', name: 'Checkout Platform' },
    counts: { slavesWorking: 0, tasksActive: 0 },
    guardrails: { budgetUsd: 2, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 5 },
    status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null, ...over },
  }
}

function settings(over: Partial<ProjectSettings['workspace']> = {}): ProjectSettings {
  return {
    workspace: {
      id: 'w1',
      name: 'Checkout Platform',
      goal: null,
      provider: 'claude_code',
      budgetUsd: 2,
      costBlindBudgeted: false,
      maxConcurrentRuns: 3,
      runTimeoutMs: 1_800_000,
      maxAttempts: 5,
      haltedReason: null,
      ...over,
    },
    permissions: {
      workspaceId: 'w1',
      workspaceName: 'Checkout Platform',
      rows: [
        {
          slaveId: 'a1',
          name: 'Alex',
          role: 'backend',
          cells: [{ tool: 'repo read', mode: 'allow' as const }],
        },
      ],
    },
  }
}

describe('ProjectSettingsClient', () => {
  it('renders the four panels in order', () => {
    render(<ProjectSettingsClient settings={settings()} shellFacts={shellFacts()} />)
    // `Panel` renders `PanelHeader` → `SectionLabel` as its first child when it has a title.
    const titles = screen.getAllByTestId('panel').map((p) => p.firstElementChild?.textContent?.trim().toLowerCase())
    expect(titles).toEqual(['goal', 'runtime', 'slave permissions', 'danger zone'])
  })

  it("shows the three limits read-only in the sidebar's old format", () => {
    render(<ProjectSettingsClient settings={settings()} shellFacts={shellFacts()} />)
    expect(screen.getByTestId('runtime-concurrency').textContent).toBe('3')
    expect(screen.getByTestId('runtime-timeout').textContent).toBe('30m')
    expect(screen.getByTestId('runtime-attempts').textContent).toBe('5')
    expect(screen.getByText(/not editable here yet/)).toBeTruthy()
  })

  it('scopes the permission matrix to this workspace', () => {
    render(<ProjectSettingsClient settings={settings()} shellFacts={shellFacts()} />)
    expect(screen.getAllByTestId(/^permission-matrix-/).length).toBe(1)
  })

  it('sets the goal then refreshes the route instead of waiting for a stream', async () => {
    render(<ProjectSettingsClient settings={settings()} shellFacts={shellFacts()} />)
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: 'Ship it' } })
    fireEvent.click(screen.getByTestId('goal-submit'))
    await waitFor(() => expect(postControl).toHaveBeenCalledWith('/api/w/w1/goal', { goal: 'Ship it' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('carries the emergency stop in the danger zone', () => {
    render(<ProjectSettingsClient settings={settings()} shellFacts={shellFacts()} />)
    expect(screen.getByTestId('emergency-stop')).toBeTruthy()
  })

  it('reseeds the runtime draft when the saved provider/budget pair changes', () => {
    // Ported from `overview-components.test.tsx`'s pre-M24 runtime-panel remount coverage (M15
    // spec §3 B4) -- there is no stream feeding this tab any more, so the mechanism this now
    // tests is `ProjectSettingsClient`'s own `key=` on `RuntimePanel`, not a wake-up event.
    const { rerender } = render(<ProjectSettingsClient settings={settings({ budgetUsd: 20 })} shellFacts={shellFacts()} />)
    expect((screen.getByLabelText('workspace budget') as HTMLInputElement).value).toBe('20')

    rerender(<ProjectSettingsClient settings={settings({ budgetUsd: 35 })} shellFacts={shellFacts()} />)

    expect((screen.getByLabelText('workspace budget') as HTMLInputElement).value).toBe('35')
  })

  // M24 final review, Important 1: the Settings tab published nothing, so the project header and
  // tab strip fell back to the layout's entry-time snapshot on this one tab.
  it('publishes ShellFacts on mount, as the four page clients do', () => {
    const facts = shellFacts({ goal: 'Ship it' })
    render(<ProjectSettingsClient settings={settings()} shellFacts={facts} />)
    expect(publishShellFacts).toHaveBeenCalledWith('w1', facts)
  })

  it('shows the halt banner only when the workspace is halted', () => {
    const { rerender } = render(<ProjectSettingsClient settings={settings()} shellFacts={shellFacts()} />)
    expect(screen.queryByRole('alert')).toBeNull()

    rerender(<ProjectSettingsClient settings={settings({ haltedReason: 'budget exceeded' })} shellFacts={shellFacts()} />)
    expect(screen.getByRole('alert').textContent).toContain('budget exceeded')
  })
})
