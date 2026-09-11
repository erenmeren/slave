// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RunbookPanel } from '../src/components/project/RunbookPanel'
import type { RunbookPanelView } from '../src/server/runbook'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const view = (overrides: Partial<RunbookPanelView>): RunbookPanelView => ({
  adopted: null,
  currentStage: null,
  stages: [],
  recommendations: [],
  all: [],
  pendingDecisionId: null,
  ...overrides,
})

describe('RunbookPanel', () => {
  it('offers each recommendation with its reason, its stage count and an Adopt button', () => {
    render(
      <RunbookPanel
        workspaceId="w1"
        view={view({
          recommendations: [{ key: 'feature-delivery', name: 'Feature delivery', description: 'd', stageCount: 5, source: 'seed', why: 'The goal says "ship".' }],
          all: [{ key: 'bug-fix', name: 'Bug fix', description: 'd', stageCount: 4, source: 'seed', why: null }],
        })}
      />,
    )
    const row = screen.getByTestId('runbook-recommendation')
    expect(row.getAttribute('data-key')).toBe('feature-delivery')
    expect(row.textContent).toContain('Feature delivery')
    expect(row.textContent).toContain('The goal says "ship".')
    expect(row.textContent).toContain('5 stages')
    expect(screen.getAllByTestId('runbook-adopt').length).toBeGreaterThan(0)
    expect(screen.getByTestId('runbook-picker')).toBeDefined()
  })

  it('shows the adopted runbook, the current stage and every stage state, with capability chips', () => {
    render(
      <RunbookPanel
        workspaceId="w1"
        view={view({
          adopted: { key: 'feature-delivery', name: 'Feature delivery', description: 'd', stageCount: 5, source: 'seed', why: null },
          currentStage: 'implement',
          stages: [
            { key: 'design', title: 'Design', objective: 'Decide', state: 'done', taskCount: 1, capabilities: [{ key: 'planning.decomposition', label: 'Work decomposition', covered: true }] },
            { key: 'implement', title: 'Implement', objective: 'Build', state: 'active', taskCount: 2, capabilities: [] },
            { key: 'release', title: 'Release', objective: 'Ship', state: 'missing', taskCount: 0, capabilities: [{ key: 'operations.deployment', label: 'Deployment', covered: false }] },
          ],
        })}
      />,
    )
    expect(screen.getByTestId('runbook-name').textContent).toBe('Feature delivery')
    expect(screen.getByTestId('runbook-current-stage').textContent).toContain('Implement')
    const rows = screen.getAllByTestId('runbook-stage-row')
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['done', 'active', 'missing'])
    expect(rows.map((row) => row.getAttribute('data-stage'))).toEqual(['design', 'implement', 'release'])
    // The words, never the key -- `docs/ia.md` rule 3.
    expect(rows[2]?.textContent).toContain('not in the plan')
    const chips = screen.getAllByTestId('runbook-capability-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual(['Work decomposition', 'Deployment'])
    expect(chips.map((chip) => chip.getAttribute('data-covered'))).toEqual(['true', 'false'])
    // A key is a machine handle here and nowhere else: `data-`/`title`, never visible text.
    expect(screen.getByTestId('runbook-panel').textContent).not.toContain('planning.decomposition')
  })

  it('renders nothing at all when there is no runbook and nothing to recommend', () => {
    const { container } = render(<RunbookPanel workspaceId="w1" view={view({})} />)
    expect(container.querySelector('[data-testid="runbook-panel"]')).toBeNull()
  })

  it('renders nothing when the snapshot has no panel at all -- a workspace read between two states', () => {
    const { container } = render(<RunbookPanel workspaceId="w1" view={null} />)
    expect(container.querySelector('[data-testid="runbook-panel"]')).toBeNull()
  })
})
