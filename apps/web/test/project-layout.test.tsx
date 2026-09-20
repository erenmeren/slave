// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// M61 R7/Task 6: the layout now seeds `CommandStrip`'s needs-you queue alongside the facts above.
vi.mock('../src/server/needsYou', () => ({
  buildNeedsYou: vi.fn(async (id: string) => (id === 'w1' ? [{ kind: 'decision', id: 'd-1', title: 'x', href: '/w/w1', since: '2026-09-19T09:00:00.000Z', taskId: null, decisionId: 'd-1', messageId: null }] : [])),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
  useSearchParams: () => new URLSearchParams(),
}))

import ProjectLayout from '../src/app/w/[workspaceId]/layout'
import { publishShellFacts, useShellFacts } from '../src/hooks/useShellFacts'
import { ModeProvider } from '../src/components/mode/ModeProvider'

/** The store `ShellFactsSeed` writes into, read the way the header reads it -- the seed itself
 *  renders nothing, so what it DID is the only thing there is to assert. */
function FactsProbe(): React.JSX.Element {
  const facts = useShellFacts('w1')
  return <span data-testid="probe">{facts?.workspace.name ?? 'nothing published'}</span>
}

/** jsdom implements `localStorage` but this runner never hands it over (`rail.test.tsx`'s own
 *  note) -- `ModeProvider`, mounted here because the layout now also renders `CommandStrip`, needs
 *  a working one for its hydration effect. */
function installStorage(): void {
  const cells = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => cells.get(key) ?? null,
    setItem: (key: string, value: string): void => void cells.set(key, value),
    removeItem: (key: string): void => void cells.delete(key),
    clear: (): void => cells.clear(),
  })
}

beforeEach((): void => {
  installStorage()
})

afterEach((): void => {
  publishShellFacts('w1', null)
  vi.unstubAllGlobals()
})

describe('the project layout', () => {
  it('renders its page and nothing else -- the header is the root layout\'s now (M57 R7)', async (): Promise<void> => {
    const tree = await ProjectLayout({
      params: Promise.resolve({ workspaceId: 'w1' }),
      children: <div data-testid="page">page</div>,
    })
    render(<ModeProvider>{tree}</ModeProvider>)
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
      <ModeProvider>
        {known}
        <FactsProbe />
      </ModeProvider>,
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
      <ModeProvider>
        {unknown}
        <FactsProbe />
      </ModeProvider>,
    )
    expect(screen.getByTestId('page').textContent).toBe('no workspace')
    expect(screen.getByTestId('probe').textContent).toBe('nothing published')
  })

  // M61 R7/Task 6: the strip is seeded for a known workspace and absent for one that does not
  // exist -- the same gate the facts seed above already carries.
  it('renders the command strip for a known workspace, and none for one that does not exist', async (): Promise<void> => {
    const known = await ProjectLayout({
      params: Promise.resolve({ workspaceId: 'w1' }),
      children: <div data-testid="page">page</div>,
    })
    const mounted = render(<ModeProvider>{known}</ModeProvider>)
    expect(screen.getByTestId('project-tabs')).toBeTruthy()
    expect(screen.getAllByTestId('project-tab').map((tab) => tab.getAttribute('data-tab'))).toEqual([
      'team', 'tasks', 'office', 'activity',
    ])
    expect(screen.getByTestId('needs-you-row').textContent).toContain('x')
    mounted.unmount()

    const unknown = await ProjectLayout({
      params: Promise.resolve({ workspaceId: 'nope' }),
      children: <div data-testid="page">no workspace</div>,
    })
    render(<ModeProvider>{unknown}</ModeProvider>)
    expect(screen.queryByTestId('project-tabs')).toBeNull()
  })
})
