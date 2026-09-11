// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunbookPanel } from '../src/components/project/RunbookPanel'
import type { RunbookPanelView } from '../src/server/runbook'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const view = (overrides: Partial<RunbookPanelView>): RunbookPanelView => ({
  adopted: null,
  currentStage: null,
  stages: [],
  recommendations: [],
  all: [],
  pendingDecision: null,
  ...overrides,
})

const option = (key: string, name: string): RunbookPanelView['all'][number] => ({
  key,
  name,
  description: 'd',
  stageCount: 4,
  source: 'seed',
  why: `The goal says "${key}".`,
})

/** Every POST this panel made, in order -- the whole point of the three cases below is WHICH url a
 *  click reaches, so the stub records rather than asserts. */
function stubFetch(): { readonly urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }),
  )
  return { urls }
}

afterEach(() => {
  vi.unstubAllGlobals()
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

  // Fix round 1, Critical: a click adopts WHAT WAS CLICKED. Approving the pending proposal is right
  // only when the person clicked the runbook that proposal is about; every other click is a
  // by-hand adoption, and the proposal stays for the timeline.
  describe('a pending proposal (fix round 1, Critical)', () => {
    const pending = { id: 'd1', key: 'security-review', name: 'Security review' }
    const recommended = view({
      recommendations: [option('security-review', 'Security review'), option('bug-fix', 'Bug fix')],
      all: [option('security-review', 'Security review'), option('bug-fix', 'Bug fix')],
      pendingDecision: pending,
    })

    it('approves the decision when the person clicks the runbook it is about', async () => {
      const { urls } = stubFetch()
      render(<RunbookPanel workspaceId="w1" view={recommended} />)
      await act(async () => {
        fireEvent.click(screen.getAllByTestId('runbook-adopt')[0] as HTMLButtonElement)
      })
      expect(urls).toEqual(['/api/w/w1/supervisor/decisions/d1/approve'])
    })

    it('adopts by hand when the person clicks a DIFFERENT runbook, leaving the proposal waiting', async () => {
      const { urls } = stubFetch()
      render(<RunbookPanel workspaceId="w1" view={recommended} />)
      await act(async () => {
        fireEvent.click(screen.getAllByTestId('runbook-adopt')[1] as HTMLButtonElement)
      })
      expect(urls).toEqual(['/api/w/w1/runbook'])
    })

    it('adopts by hand from the picker too, and says the proposal is still waiting', async () => {
      const { urls } = stubFetch()
      render(<RunbookPanel workspaceId="w1" view={recommended} />)
      // Said BEFORE the click, which is when it is useful: the name, never the key, and it points
      // at the one surface that can answer the proposal.
      const note = screen.getByTestId('runbook-pending-note')
      expect(note.textContent).toContain('Security review')
      expect(note.textContent).toContain('timeline')
      expect(note.textContent).not.toContain('security-review')

      fireEvent.change(screen.getByTestId('runbook-picker'), { target: { value: 'bug-fix' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('runbook-picker-adopt'))
      })
      expect(urls).toEqual(['/api/w/w1/runbook'])
    })

    it('says nothing about a proposal the project has already adopted', () => {
      render(
        <RunbookPanel
          workspaceId="w1"
          view={view({
            adopted: { ...option('security-review', 'Security review'), why: null },
            all: [option('security-review', 'Security review'), option('bug-fix', 'Bug fix')],
            pendingDecision: pending,
          })}
        />,
      )
      expect(screen.queryByTestId('runbook-pending-note')).toBeNull()
    })
  })

  // Fix round 1, minor 7: the picker offers what you could switch TO.
  it('leaves the adopted runbook out of the picker, and will not adopt nothing', () => {
    render(
      <RunbookPanel
        workspaceId="w1"
        view={view({
          adopted: { ...option('feature-delivery', 'Feature delivery'), why: null },
          all: [option('feature-delivery', 'Feature delivery'), option('bug-fix', 'Bug fix')],
        })}
      />,
    )
    const options = [...screen.getByTestId('runbook-picker').querySelectorAll('option')].map((node) => node.getAttribute('value'))
    expect(options).toEqual(['', 'bug-fix'])
    expect((screen.getByTestId('runbook-picker-adopt') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('runbook-picker'), { target: { value: 'bug-fix' } })
    expect((screen.getByTestId('runbook-picker-adopt') as HTMLButtonElement).disabled).toBe(false)
  })

  it('clears the picker once the write lands, so the box does not claim a choice that happened', async () => {
    stubFetch()
    render(
      <RunbookPanel
        workspaceId="w1"
        view={view({ recommendations: [option('bug-fix', 'Bug fix')], all: [option('bug-fix', 'Bug fix')] })}
      />,
    )
    fireEvent.change(screen.getByTestId('runbook-picker'), { target: { value: 'bug-fix' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runbook-picker-adopt'))
    })
    expect((screen.getByTestId('runbook-picker') as HTMLSelectElement).value).toBe('')
  })

  it('renders nothing at all when there is no runbook, nothing to recommend and nothing to pick', () => {
    const { container } = render(<RunbookPanel workspaceId="w1" view={view({})} />)
    expect(container.querySelector('[data-testid="runbook-panel"]')).toBeNull()
  })

  // M48 final review, Minor 1: the builder recommends only on an empty board, so this is the shape
  // a project with tasks and no runbook arrives in -- the picker, and no suggestion.
  it('shows the picker alone when there is nothing to recommend but runbooks to choose from', () => {
    render(
      <RunbookPanel workspaceId="w1" view={view({ recommendations: [], all: [option('bug-fix', 'Bug fix')] })} />,
    )
    expect(screen.queryAllByTestId('runbook-recommendation')).toHaveLength(0)
    expect(screen.getByTestId('runbook-panel').textContent).not.toContain('recommended for this goal')
    const options = [...screen.getByTestId('runbook-picker').querySelectorAll('option')].map((node) => node.getAttribute('value'))
    expect(options).toEqual(['', 'bug-fix'])
    // Nothing is adopted, so there is nothing to stop following.
    expect(screen.queryByTestId('runbook-clear')).toBeNull()
  })

  // M48 final review, Minor 9: the two controls are independent.
  it('offers Clear whenever a runbook is adopted, even with nothing else to switch to', async () => {
    const { urls } = stubFetch()
    render(
      <RunbookPanel
        workspaceId="w1"
        view={view({
          adopted: { ...option('feature-delivery', 'Feature delivery'), why: null },
          // The ONLY runbook in the database is the adopted one, so the picker has no rows at all.
          all: [option('feature-delivery', 'Feature delivery')],
        })}
      />,
    )
    expect(screen.queryByTestId('runbook-picker')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runbook-clear'))
    })
    expect(urls).toEqual(['/api/w/w1/runbook'])
  })

  it('renders nothing when the snapshot has no panel at all -- a workspace read between two states', () => {
    const { container } = render(<RunbookPanel workspaceId="w1" view={null} />)
    expect(container.querySelector('[data-testid="runbook-panel"]')).toBeNull()
  })
})
