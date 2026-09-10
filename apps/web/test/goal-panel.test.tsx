// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoalVersionView } from '../src/server/goal.js'
import { GoalPanel } from '../src/components/project/GoalPanel.js'

const refresh = vi.fn()
const push = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push }) }))

const POST_URL = '/api/w/w1/goal'
const HISTORY_URL = '/api/w/w1/goal/history'

/** The two versions of a goal, as `listGoalVersions` returns them: newest first, each row's diff
 *  against the row below it, and `null` for the first version -- which replaced nothing. */
const HISTORY: readonly GoalVersionView[] = [
  {
    version: 2,
    text: 'ship checkout\nand the refunds flow',
    sha256: 'b'.repeat(64),
    setByUserId: 'u-1',
    createdAt: '2026-09-10T11:30:00.000Z',
    diff: { added: ['and the refunds flow'], removed: [] },
  },
  {
    version: 1,
    text: 'ship checkout',
    sha256: 'a'.repeat(64),
    setByUserId: null,
    createdAt: '2026-09-09T08:00:00.000Z',
    diff: null,
  },
]

describe('GoalPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  /** The default wiring: a save succeeds at v2, the history read returns {@link HISTORY}. */
  const wire = (over?: { readonly post?: Response; readonly history?: Response }): void => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return over?.post ?? new Response(JSON.stringify({ ok: true, version: 2, sha256: 'b'.repeat(64) }), { status: 200 })
      }
      if (url === HISTORY_URL) return over?.history ?? new Response(JSON.stringify(HISTORY), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    wire()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('renders the form when goal is null, and offers no history to read', () => {
    render(<GoalPanel workspaceId="w1" goal={null} goalVersion={0} boardTaskCount={0} />)

    expect(screen.getByRole('textbox', { name: 'workspace goal' })).toBeTruthy()
    expect(screen.getByTestId('goal-submit')).toBeTruthy()
    expect(screen.queryByTestId('workspace-goal')).toBeNull()
    // A project whose goal was never set has no version: a history toggle that can only open an
    // empty list is a control that lies.
    expect(screen.queryByTestId('goal-history-toggle')).toBeNull()
  })

  it('posts the typed text to the goal route', async () => {
    render(<GoalPanel workspaceId="w1" goal={null} goalVersion={0} boardTaskCount={0} />)
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: 'ship the redesign' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith(POST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'ship the redesign' }),
    })
    expect(refresh).toHaveBeenCalled()
  })

  it('renders the goal read-only with its version when set', () => {
    render(<GoalPanel workspaceId="w1" goal="ship the redesign" goalVersion={3} boardTaskCount={2} />)

    expect(screen.getByTestId('workspace-goal').textContent).toBe('ship the redesign')
    expect(screen.getByTestId('goal-version').textContent).toBe('v3')
    expect(screen.queryByTestId('goal-input')).toBeNull()
  })

  it('shows no version chip for a goal that carries no recorded version', () => {
    render(<GoalPanel workspaceId="w1" goal="hand-seeded before M40" goalVersion={0} boardTaskCount={1} />)

    expect(screen.queryByTestId('goal-version')).toBeNull()
  })

  it('an edit button switches a set goal back to the form, seeded with the current goal', () => {
    render(<GoalPanel workspaceId="w1" goal="ship checkout" goalVersion={1} boardTaskCount={0} />)
    expect(screen.queryByTestId('goal-input')).toBeNull()

    fireEvent.click(screen.getByTestId('goal-edit'))

    expect((screen.getByTestId('goal-input') as HTMLInputElement).value).toBe('ship checkout')
    expect(screen.queryByTestId('workspace-goal')).toBeNull()
  })

  it('a refusal lands in the alert span and is not mistaken for "no change"', async () => {
    wire({ post: new Response(JSON.stringify({ error: 'a goal must be a non-empty text', kind: 'invalid_goal' }), { status: 409 }) })
    render(<GoalPanel workspaceId="w1" goal={null} goalVersion={0} boardTaskCount={0} />)
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: '  ' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(screen.getByRole('alert').textContent).toContain('a goal must be a non-empty text')
    expect(screen.queryByTestId('goal-unchanged')).toBeNull()
    // A failed submit stays in form mode.
    expect(screen.getByTestId('goal-input')).toBeTruthy()
    expect(refresh).not.toHaveBeenCalled()
  })

  /** M40 erratum E5 + the t4 ruling: `goal_unchanged` is a refusal in the CLI and a NON-event in
   *  the browser -- a person pressed save on the words already there, and a red band would tell
   *  them they broke something by saving what was already true. */
  it('renders goal_unchanged as "no change — still vN", not as an error', async () => {
    wire({
      post: new Response(
        JSON.stringify({ error: 'the goal of project w1 already reads exactly this at version 2: nothing was recorded', kind: 'goal_unchanged' }),
        { status: 409 },
      ),
    })
    render(<GoalPanel workspaceId="w1" goal="ship checkout" goalVersion={2} boardTaskCount={3} />)
    fireEvent.click(screen.getByTestId('goal-edit'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(screen.getByTestId('goal-unchanged').textContent).toBe('no change — still v2')
    expect(screen.queryByTestId('goal-error')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // Nothing moved, so nothing is re-planning either.
    expect(screen.queryByTestId('goal-replan-note')).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('says a re-plan will run after an edit that landed on a non-empty board', async () => {
    render(<GoalPanel workspaceId="w1" goal="ship checkout" goalVersion={1} boardTaskCount={4} />)
    fireEvent.click(screen.getByTestId('goal-edit'))
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: 'ship checkout and refunds' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(screen.getByTestId('goal-replan-note').textContent).toBe('a re-plan will run on the next tick')
  })

  it('says nothing about a re-plan when the board is empty -- that edit takes the first-plan path', async () => {
    render(<GoalPanel workspaceId="w1" goal="ship checkout" goalVersion={1} boardTaskCount={0} />)
    fireEvent.click(screen.getByTestId('goal-edit'))
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: 'ship checkout and refunds' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('goal-submit'))
    })

    expect(screen.queryByTestId('goal-replan-note')).toBeNull()
    expect(refresh).toHaveBeenCalled()
  })

  describe('the history', () => {
    const open = async (): Promise<void> => {
      render(<GoalPanel workspaceId="w1" goal="ship checkout\nand the refunds flow" goalVersion={2} boardTaskCount={2} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('goal-history-toggle'))
      })
    }

    it('reads the history route only once it is asked for, and lists the versions newest first', async () => {
      render(<GoalPanel workspaceId="w1" goal="ship checkout" goalVersion={2} boardTaskCount={2} />)
      expect(fetchMock).not.toHaveBeenCalled()

      await act(async () => {
        fireEvent.click(screen.getByTestId('goal-history-toggle'))
      })

      expect(fetchMock).toHaveBeenCalledWith(HISTORY_URL)
      expect(screen.getAllByTestId('goal-history-version').map((one) => one.textContent)).toEqual(['v2', 'v1'])
      expect(screen.getAllByTestId('goal-history-text').map((one) => one.textContent)).toEqual([
        'ship checkout\nand the refunds flow',
        'ship checkout',
      ])
    })

    it('renders each version\'s line diff as text lines', async () => {
      await open()

      expect(screen.getAllByTestId('goal-diff-added').map((one) => one.textContent)).toEqual(['+ and the refunds flow'])
      expect(screen.queryAllByTestId('goal-diff-removed')).toHaveLength(0)
      // v1 replaced nothing, so it carries no diff at all.
      expect(screen.getAllByTestId('goal-history-entry')).toHaveLength(2)
    })

    it('renders a removed line too', async () => {
      wire({
        history: new Response(
          JSON.stringify([
            { ...HISTORY[0], diff: { added: ['and the refunds flow'], removed: ['ship checkout by friday'] } },
            HISTORY[1],
          ]),
          { status: 200 },
        ),
      })
      await open()

      expect(screen.getAllByTestId('goal-diff-removed').map((one) => one.textContent)).toEqual(['- ship checkout by friday'])
    })

    it('collapses again on a second click, and re-reads on the next open', async () => {
      await open()
      expect(screen.getByTestId('goal-history')).toBeTruthy()

      await act(async () => {
        fireEvent.click(screen.getByTestId('goal-history-toggle'))
      })
      expect(screen.queryByTestId('goal-history')).toBeNull()

      await act(async () => {
        fireEvent.click(screen.getByTestId('goal-history-toggle'))
      })
      // Twice: a goal set from the CLI between two opens must not leave this list stale.
      expect(fetchMock.mock.calls.filter((call) => call[0] === HISTORY_URL)).toHaveLength(2)
    })

    it('shows the route\'s own words when the read fails', async () => {
      wire({ history: new Response(JSON.stringify({ error: 'no such workspace' }), { status: 404 }) })
      render(<GoalPanel workspaceId="w1" goal="ship checkout" goalVersion={2} boardTaskCount={2} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('goal-history-toggle'))
      })

      expect(screen.getByTestId('goal-history-error').textContent).toBe('no such workspace')
      expect(screen.queryByTestId('goal-history')).toBeNull()
    })
  })
})
