// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/server/shell', () => ({
  buildShellFacts: vi.fn(async (id: string) =>
    id === 'w1'
      ? {
          workspace: { id, name: 'Checkout Platform' },
          counts: { slavesWorking: 0, tasksActive: 3, slavesPaused: 0 },
          guardrails: { budgetUsd: 2, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 5 },
          status: { goal: 'Ship it', spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
        }
      : null,
  ),
}))

import ProjectLayout from '../src/app/w/[workspaceId]/layout'
import { publishShellFacts, useShellFacts } from '../src/hooks/useShellFacts'

/** The store `ShellFactsSeed` writes into, read the way the header reads it -- the seed itself
 *  renders nothing, so what it DID is the only thing there is to assert. */
function FactsProbe(): React.JSX.Element {
  const facts = useShellFacts('w1')
  return <span data-testid="probe">{facts?.workspace.name ?? 'nothing published'}</span>
}

afterEach((): void => {
  publishShellFacts('w1', null)
})

describe('the project layout', () => {
  it('renders its page and nothing else -- the header is the root layout\'s now (M57 R7)', async (): Promise<void> => {
    const tree = await ProjectLayout({
      params: Promise.resolve({ workspaceId: 'w1' }),
      children: <div data-testid="page">page</div>,
    })
    render(tree)
    expect(screen.getByTestId('page')).toBeTruthy()
    expect(screen.queryByTestId('app-header')).toBeNull()
    expect(screen.queryByTestId('project-header')).toBeNull()
  })

  // Spec erratum E12: three of this segment's eight pages publish no facts of their own, so the
  // layout's own read is what keeps the header's budget and split button on them.
  it('seeds the shell facts for a known workspace, and seeds nothing for one that does not exist', async (): Promise<void> => {
    const known = await ProjectLayout({
      params: Promise.resolve({ workspaceId: 'w1' }),
      children: <div data-testid="page">page</div>,
    })
    const mounted = render(
      <>
        {known}
        <FactsProbe />
      </>,
    )
    expect(screen.getByTestId('probe').textContent).toBe('Checkout Platform')
    // Unmounted before the second case so the seed's own retraction runs: leaving it up would let
    // the first project's publication answer the second project's probe.
    mounted.unmount()

    const unknown = await ProjectLayout({
      params: Promise.resolve({ workspaceId: 'nope' }),
      children: <div data-testid="page">no workspace</div>,
    })
    render(
      <>
        {unknown}
        <FactsProbe />
      </>,
    )
    expect(screen.getByTestId('page').textContent).toBe('no workspace')
    expect(screen.getByTestId('probe').textContent).toBe('nothing published')
  })
})
