// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoalHistory } from '../src/components/project/GoalHistory'

const ORIGIN = {
  source: 'github',
  repository: 'acme/checkout',
  ref: '#412',
  url: 'https://github.com/acme/checkout/issues/412',
}

const HISTORY = [
  { version: 2, text: 'v2', sha256: 'b', setByUserId: null, createdAt: '2026-09-13T10:00:00.000Z', diff: null, origin: ORIGIN },
  { version: 1, text: 'v1', sha256: 'a', setByUserId: null, createdAt: '2026-09-12T10:00:00.000Z', diff: null, origin: null },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubHistory(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(HISTORY), { status: 200, headers: { 'content-type': 'application/json' } })),
  )
}

/** The toggle's click, and the fetch it starts, settled before an assertion reads the DOM.
 *
 *  `fireEvent` inside an async `act`, not `userEvent`: `@testing-library/user-event` is not a
 *  dependency of this repository and is imported by no other test here. Same shape
 *  `goal-panel.test.tsx` already drives this component's toggle with. */
async function openHistory(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('goal-history-toggle'))
  })
}

describe('GoalHistory says where a version came from (M54 R9)', () => {
  it('renders the sentence on the externally-originated row and on no other', async () => {
    stubHistory()
    render(<GoalHistory workspaceId="w1" />)
    await openHistory()
    await waitFor(() => expect(screen.getAllByTestId('goal-history-entry')).toHaveLength(2))
    const origins = screen.getAllByTestId('goal-history-origin')
    expect(origins).toHaveLength(1)
    expect(origins[0]?.textContent).toContain('from GitHub')
    expect(origins[0]?.textContent).toContain('acme/checkout#412')
  })

  it('keeps the raw source out of the visible text and on a data attribute', async () => {
    stubHistory()
    render(<GoalHistory workspaceId="w1" />)
    await openHistory()
    await waitFor(() => expect(screen.getAllByTestId('goal-history-origin')).toHaveLength(1))
    const chip = screen.getByTestId('goal-history-origin')
    expect(chip.getAttribute('data-external-source')).toBe('github')
    expect(chip.textContent).not.toContain('github')
  })

  it('still renders a history whose rows carry no `origin` key at all -- every row before M54', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify([{ version: 1, text: 'v1', sha256: 'a', setByUserId: null, createdAt: '2026-09-12T10:00:00.000Z', diff: null }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    render(<GoalHistory workspaceId="w1" />)
    await openHistory()
    await waitFor(() => expect(screen.getAllByTestId('goal-history-entry')).toHaveLength(1))
    expect(screen.queryByTestId('goal-history-origin')).toBeNull()
  })

  // The row is still the version's row: the origin sits between the version and the timestamp and
  // replaces neither, for the reason the task card's does -- WHICH requirement and WHO asked for it
  // are two different facts.
  it('leaves the version and the timestamp on the row it stamps', async () => {
    stubHistory()
    render(<GoalHistory workspaceId="w1" />)
    await openHistory()
    await waitFor(() => expect(screen.getAllByTestId('goal-history-entry')).toHaveLength(2))
    expect(screen.getAllByTestId('goal-history-version').map((one) => one.textContent)).toEqual(['v2', 'v1'])
    expect(screen.getAllByTestId('goal-history-at')[0]?.textContent).toBe('2026-09-13 10:00:00')
  })

  // `origin` is a `Json` column on the way here, and a hand edit or a future writer can put a shape
  // in it this build cannot read. The page renders nothing for such a row rather than throwing
  // inside a render -- the same answer `listGoalVersions` gives for the column itself.
  it('renders nothing, and does not throw, for a row whose origin will not parse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { version: 1, text: 'v1', sha256: 'a', setByUserId: null, createdAt: '2026-09-12T10:00:00.000Z', diff: null, origin: { source: 'myspace' } },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    render(<GoalHistory workspaceId="w1" />)
    await openHistory()
    await waitFor(() => expect(screen.getAllByTestId('goal-history-entry')).toHaveLength(1))
    expect(screen.queryByTestId('goal-history-origin')).toBeNull()
    expect(screen.queryByTestId('goal-history-error')).toBeNull()
  })
})
