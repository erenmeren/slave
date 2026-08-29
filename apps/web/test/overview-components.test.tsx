// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentCard } from '../src/components/AgentCard.js'
import { HaltBanner } from '../src/components/HaltBanner.js'
import { TopStrip } from '../src/components/TopStrip.js'
import type { AgentCardData, OverviewSnapshot } from '../src/server/overview.js'

const agent = (over: Partial<AgentCardData>): AgentCardData => ({
  id: 'a1',
  name: 'Alex',
  role: 'backend',
  // M12 Task 9 / ruling R10: `'claude_code'` is the `ProviderKind` (the column). The old value
  // here, `'claude-code'`, was the ADAPTER ID -- a spelling no row ever held, from before
  // `overview.ts` had a real column to read.
  provider: 'claude_code',
  // `capabilitiesOf('claude_code').gate` (M12 Task 13 fix round 1, spec §8 / finding 4a) --
  // paired with the default `provider` above the same way `AgentCardData.gate` is server-derived
  // from `AgentCardData.provider`, never a second table.
  gate: 'all-tools',
  status: 'idle',
  taskTitle: null,
  actionLine: null,
  runId: null,
  queuedMessage: null,
  resumeRequestedAt: null,
  recentEvents: [],
  costUsd: 0,
  toolCalls: 0,
  pausedAtStep: null,
  sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ...over,
})

const snapshot = (agents: readonly AgentCardData[]): OverviewSnapshot => ({
  workspace: { id: 'w1', name: 'W', haltedReason: null, haltedAt: null, budgetUsd: 100, spentUsd: 3, unmeasuredRuns: 0, goal: null, provider: 'claude_code', costBlindBudgeted: false },
  agents,
  tasks: { active: 2, blocked: 1, done: 4, failed: 0 },
})

describe('AgentCard provider chip', () => {
  it("renders the run's own provider kind, and the unknown mark when no run has resolved one", () => {
    // M12 Task 9 / ruling R10. The bare kind: the human-readable label and the shell-only gate
    // mark belong to Task 13 (spec §8), and inventing either here would be that task's decision
    // taken by the wrong task.
    const { rerender } = render(<AgentCard agent={agent({ provider: 'cursor', gate: 'all-tools' })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.getByTestId('provider-chip').textContent).toBe('cursor')

    rerender(<AgentCard agent={agent({ provider: null, gate: null })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.getByTestId('provider-chip').textContent).toBe('—')
  })

  // M12 Task 13 fix round 1, spec §8 / finding 4a: "wherever a worker's runtime is shown, a
  // provider whose gate is shell-only is marked as such". `gate` is server-derived
  // (`overview.ts`, via `capabilitiesOf`), never recomputed here.
  it('marks a shell-only gate, and shows no mark for a runtime that gates every tool', () => {
    // `gate` is server-derived (`overview.ts`, via `capabilitiesOf`). As of M13 Task 10 no shipped
    // provider reports `shell-only` -- Cursor's gate was proven to cover writes too -- so this
    // fixture is hand-written: the MARK is still part of the contract, and a third runtime that
    // gates only shells must light it up on day one.
    const { rerender } = render(<AgentCard agent={agent({ provider: 'cursor', gate: 'shell-only' })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.getByText(/shell only/i)).toBeTruthy()

    rerender(<AgentCard agent={agent({ provider: 'cursor', gate: 'all-tools' })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.queryByText(/shell only/i)).toBeNull()
  })
})

describe('TopStrip', () => {
  it('groups agent counts by derived status', () => {
    render(
      <TopStrip
        snapshot={snapshot([
          agent({ id: 'a1', status: 'working' }),
          agent({ id: 'a2', status: 'working' }),
          agent({ id: 'a3', status: 'paused' }),
          agent({ id: 'a4', status: 'idle' }),
        ])}
      />,
    )
    expect(screen.getByTestId('count-working').textContent).toContain('2')
    expect(screen.getByTestId('count-paused').textContent).toContain('1')
    expect(screen.getByTestId('count-idle').textContent).toContain('1')
    expect(screen.getByTestId('count-tasks-active').textContent).toContain('2')
    expect(screen.getByTestId('count-tasks-blocked').textContent).toContain('1')
  })
})

describe('AgentCard', () => {
  it('shows a working agent with its task and live action line', () => {
    render(
      <AgentCard
        agent={agent({ status: 'working', taskTitle: 'Add the thing', actionLine: 'Read a.ts' })}
        liveActionLine="Write note3.txt"
        onOpen={() => {}}
      />,
    )
    // The live line wins over the snapshot's (spec §6) — the stream is fresher by construction.
    expect(screen.getByTestId('action-line').textContent).toBe('Write note3.txt')
    expect(screen.getByText('Add the thing')).toBeTruthy()
    expect(screen.getByTestId('status-label').textContent).toBe('working')
  })

  it('falls back to the snapshot action line when no live one has arrived', () => {
    render(<AgentCard agent={agent({ status: 'working', actionLine: 'Read a.ts' })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.getByTestId('action-line').textContent).toBe('Read a.ts')
  })

  it('pulses only while working', () => {
    const { rerender } = render(<AgentCard agent={agent({ status: 'working' })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.getByTestId('status-dot').className).toContain('animate-pulse')
    rerender(<AgentCard agent={agent({ status: 'paused' })} liveActionLine={null} onOpen={() => {}} />)
    // Motion carries information (spec §7): a pulsing paused agent is a lie on screen.
    expect(screen.getByTestId('status-dot').className).not.toContain('animate-pulse')
  })

  it('opens the detail panel via onOpen when the header is clicked — no more disabled M4 buttons', () => {
    const onOpen = vi.fn()
    render(<AgentCard agent={agent({ id: 'a9', status: 'working' })} liveActionLine={null} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /open alex's detail panel/i }))
    expect(onOpen).toHaveBeenCalledWith('a9')
    // The M5 controls live in the panel now (spec §6) — the card carries no pause/stop of its own.
    expect(screen.queryByTitle('arrives in M5')).toBeNull()
    expect(screen.queryByTitle('stop arrives in M5')).toBeNull()
  })

  it('renders the mini sparkline svg from agent.sparkline when data is present (Task 9)', () => {
    const { container } = render(
      <AgentCard
        agent={agent({ status: 'working', sparkline: [0, 0, 1, 0, 2, 0, 0, 3, 0, 1] })}
        liveActionLine={null}
        onOpen={() => {}}
      />,
    )
    const svg = container.querySelector('svg[role="img"]')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('width')).toBe('60')
    expect(svg?.getAttribute('height')).toBe('16')
  })

  // Motion pass (spec §8 / M4 deferral). jsdom can't see the animation itself, so these pin the
  // mechanism the CSS relies on: a key that remounts on text change (fresh DOM node → the
  // cross-fade keyframe replays), a status-flash trigger with its motion-safe class and timed
  // decay, and the `motion-safe:` variant gating every animation class for reduced-motion.
  describe('motion (spec §8)', () => {
    it("cross-fades the action line via a key that remounts when the line's text changes", () => {
      const { container, rerender } = render(
        <AgentCard agent={agent({ status: 'working', actionLine: 'Read a.ts' })} liveActionLine={null} onOpen={() => {}} />,
      )
      const first = container.querySelector('[data-testid="action-line"] > span')
      expect(first).toBeTruthy()
      expect(first?.className).toContain('motion-safe:animate-[action-line-in_120ms_ease-out]')

      rerender(<AgentCard agent={agent({ status: 'working', actionLine: 'Write b.ts' })} liveActionLine={null} onOpen={() => {}} />)
      const second = container.querySelector('[data-testid="action-line"] > span')
      // A different key means React unmounts the old span and mounts a new DOM node — that
      // remount is what makes the cross-fade keyframe run again on every text change.
      expect(second).not.toBe(first)
      expect(second?.textContent).toBe('Write b.ts')
    })

    it('carries data-status and a transition-colors border, ready for the flash to animate against', () => {
      const { container } = render(<AgentCard agent={agent({ status: 'working' })} liveActionLine={null} onOpen={() => {}} />)
      const card = container.querySelector('article')
      expect(card?.getAttribute('data-status')).toBe('working')
      expect(card?.className).toContain('transition-colors')
    })

    it('flashes the border motion-safe class on a status change and clears it after 800ms', () => {
      vi.useFakeTimers()
      try {
        const { container, rerender } = render(<AgentCard agent={agent({ status: 'working' })} liveActionLine={null} onOpen={() => {}} />)
        const card = () => container.querySelector('article')!
        // No status change yet (this is the initial mount) — no flash.
        expect(card().className).not.toContain('motion-safe:animate-[border-flash_800ms_ease-out]')

        rerender(<AgentCard agent={agent({ status: 'paused' })} liveActionLine={null} onOpen={() => {}} />)
        expect(card().className).toContain('motion-safe:animate-[border-flash_800ms_ease-out]')
        expect(card().getAttribute('style') ?? '').toContain('--flash-color')

        act(() => {
          vi.advanceTimersByTime(800)
        })
        expect(card().className).not.toContain('motion-safe:animate-[border-flash_800ms_ease-out]')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('HaltBanner', () => {
  it('shows the reason verbatim and names clear-halt', () => {
    render(<HaltBanner reason="the pause gate failed open (PreToolUse:Write exited 127)" />)
    expect(screen.getByRole('alert').textContent).toContain('PreToolUse:Write')
    expect(screen.getByRole('alert').textContent).toContain('clear-halt')
  })
})
