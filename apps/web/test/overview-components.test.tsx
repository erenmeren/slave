// @vitest-environment jsdom
import type { TaskStatus } from '@ai-team-os/domain'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { AgentCard } from '../src/components/AgentCard.js'
import { HaltBanner } from '../src/components/HaltBanner.js'
import { BlockedPanel, LiveEventsPanel, MergeQueuePanel } from '../src/components/OverviewClient.js'
import { ShellFactsProvider } from '../src/components/ShellFactsContext.js'
import { ProjectNav } from '../src/components/Sidebar.js'
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
  // M14 Task 2: the five fields the handoff's card anatomy reads -- the mono task reference, the
  // task status that reaches `blocked`/`review`/`done`, the tool-call progress, and the skill chip.
  taskId: null,
  taskStatus: null,
  progressPct: 0,
  stepLabel: null,
  skill: null,
  actionLine: null,
  runId: null,
  queuedMessage: null,
  resumeRequestedAt: null,
  recentEvents: [],
  costUsd: 0,
  toolCalls: 0,
  pausedAtStep: null,
  ...over,
})

const snapshot = (agents: readonly AgentCardData[]): OverviewSnapshot => ({
  workspace: {
    id: 'w1', name: 'W', haltedReason: null, haltedAt: null, budgetUsd: 100, spentUsd: 3, unmeasuredRuns: 0,
    goal: null, provider: 'claude_code', costBlindBudgeted: false,
    // M14 Task 8: the three guardrail columns the sidebar's bottom block reads. They live on the
    // overview snapshot so the page can PROVIDE `ShellFacts` from the stream it already has,
    // rather than the sidebar opening a second `EventSource` of its own on every workspace page.
    maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3,
  },
  agents,
  tasks: { active: 2, ready: 3, blocked: 1, done: 4, failed: 0 },
  blocked: [],
  liveEvents: [],
  mergeQueue: [],
  goalSuggestions: [],
})

describe('AgentCard provider chip', () => {
  it("renders the run's own provider kind, and the unknown mark when no run has resolved one", () => {
    // M12 Task 9 / ruling R10. The bare kind: the human-readable label and the shell-only gate
    // mark belong to Task 13 (spec §8), and inventing either here would be that task's decision
    // taken by the wrong task.
    const { rerender } = render(<AgentCard agent={agent({ provider: 'cursor', gate: 'all-tools' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.getByTestId('provider-chip').textContent).toBe('cursor')

    rerender(<AgentCard agent={agent({ provider: null, gate: null })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
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
    const { rerender } = render(<AgentCard agent={agent({ provider: 'cursor', gate: 'shell-only' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.getByText(/shell only/i)).toBeTruthy()

    rerender(<AgentCard agent={agent({ provider: 'cursor', gate: 'all-tools' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.queryByText(/shell only/i)).toBeNull()
  })
})

// The M11 strip's three agent buckets (`count-working` / `count-paused` / `count-idle`) are GONE
// as of M14 Task 8: the handoff's 1a strip is a fixed 6-up — agents working · tasks active ·
// tasks ready · tasks done · blocked · spend — and `paused`/`idle` are not among its six. A
// paused agent still says so on its own card's pill (the ten states above), which is where the
// handoff puts that fact; the strip answers "how much work is moving", not "what is each agent
// doing". So this replaces the old bucket assertions rather than sitting beside them.
describe('TopStrip \u2014 the handoff 6-up', () => {
  it('renders six tiles in the README order with 1px gutters', () => {
    render(<TopStrip snapshot={snapshot([agent({ status: 'working' })])} />)
    const tiles = screen.getAllByTestId('strip-tile')
    expect(tiles.map((t) => t.getAttribute('data-strip'))).toEqual([
      'agents-working', 'tasks-active', 'tasks-ready', 'tasks-done', 'blocked', 'spend',
    ])
    // jsdom loads no CSS: the class is the assertion. `gap-px` over a `bg-line` section is what
    // makes the hairline show THROUGH the grid rather than being drawn per tile.
    expect(screen.getByTestId('strip').className).toContain('gap-px')
    expect(screen.getByTestId('strip').className).toContain('grid-cols-6')
    expect(screen.getByTestId('strip').className).toContain('bg-line')
  })

  it('counts agents, tasks and spend into their own tiles', () => {
    render(
      <TopStrip
        snapshot={snapshot([
          agent({ id: 'a1', status: 'working' }),
          agent({ id: 'a2', status: 'working' }),
          agent({ id: 'a3', status: 'paused' }),
        ])}
      />,
    )
    expect(screen.getByTestId('strip-value-agents-working').textContent).toBe('2')
    expect(screen.getByTestId('strip-value-tasks-active').textContent).toBe('2')
    expect(screen.getByTestId('strip-value-tasks-ready').textContent).toBe('3')
    expect(screen.getByTestId('strip-value-tasks-done').textContent).toBe('4')
    expect(screen.getByTestId('strip-value-blocked').textContent).toBe('1')
  })

  it('renders spend as known spend, with the unmeasured count as its own line', () => {
    render(<TopStrip snapshot={snapshot([])} />)
    expect(screen.getByTestId('strip-value-spend').textContent).toBe('$3.00')
    // Nothing unmeasured in this fixture, so nothing is claimed about a hole in the total.
    expect(screen.queryByTestId('strip-unmeasured')).toBeNull()
  })

  it('says how many runs went unmeasured, rather than letting known spend read as total spend', () => {
    const view = snapshot([])
    render(<TopStrip snapshot={{ ...view, workspace: { ...view.workspace, unmeasuredRuns: 2 } }} />)
    expect(screen.getByTestId('strip-unmeasured').textContent).toBe('2 unmeasured')
  })

  it('tones a non-zero count and leaves a zero neutral', () => {
    const view = snapshot([agent({ status: 'working' })])
    render(<TopStrip snapshot={view} />)
    expect(screen.getByTestId('strip-value-agents-working').className).toContain('text-tone-working')
    expect(screen.getByTestId('strip-value-blocked').className).toContain('text-tone-blocked')

    const quiet = { ...view, agents: [], tasks: { active: 0, ready: 0, blocked: 0, done: 0, failed: 0 } }
    render(<TopStrip snapshot={quiet} />)
    // Two strips are mounted now; the second one's tiles are the later half of the query.
    const blocked = screen.getAllByTestId('strip-value-blocked').at(-1)
    expect(blocked?.className).toContain('text-text-1')
    expect(blocked?.className).not.toContain('text-tone-blocked')
  })
})

describe('AgentCard', () => {
  it('shows a working agent with its task and live action line', () => {
    render(
      <AgentCard
        agent={agent({ status: 'working', taskTitle: 'Add the thing', actionLine: 'Read a.ts' })}
        liveActionLine="Write note3.txt"
        workspaceId="w1" onOpen={() => {}}
      />,
    )
    // The live line wins over the snapshot's (spec §6) — the stream is fresher by construction.
    expect(screen.getByTestId('action-line').textContent).toBe('Write note3.txt')
    expect(screen.getByText('Add the thing')).toBeTruthy()
    // M14 Task 2: the card says its state in the handoff's `StatusPill` vocabulary now, not the
    // raw `AgentStatus` word the M5 card printed into `status-label`.
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')
  })

  it('falls back to the snapshot action line when no live one has arrived', () => {
    render(<AgentCard agent={agent({ status: 'working', actionLine: 'Read a.ts' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.getByTestId('action-line').textContent).toBe('Read a.ts')
  })

  it('pulses only while working', () => {
    // M14 Task 2: the dot moved inside `StatusPill` (its first child) and the keyframe is the
    // shared `status-pulse` one, not Tailwind's `animate-pulse`. The rule is unchanged.
    const dot = (): Element => screen.getByTestId('status-pill').firstElementChild as Element
    const { rerender } = render(<AgentCard agent={agent({ status: 'working' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(dot().className).toContain('motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]')
    rerender(<AgentCard agent={agent({ status: 'paused' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    // Motion carries information (spec §7): a pulsing paused agent is a lie on screen.
    expect(dot().className).not.toContain('status-pulse')
  })

  it('opens the detail panel via onOpen when the header is clicked — no more disabled M4 buttons', () => {
    const onOpen = vi.fn()
    render(<AgentCard agent={agent({ id: 'a9', status: 'working' })} liveActionLine={null} workspaceId="w1" onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /open alex's detail panel/i }))
    expect(onOpen).toHaveBeenCalledWith('a9')
    // The M5 controls live in the panel now (spec §6) — the card carries no pause/stop of its own.
    expect(screen.queryByTitle('arrives in M5')).toBeNull()
    expect(screen.queryByTitle('stop arrives in M5')).toBeNull()
  })

  // The M11 mini-sparkline is GONE from this card as of M14 Task 2: the handoff's card anatomy
  // (design README "1a") gives that row to the progress bar and the step/percent counter, and a
  // card carrying both would be two answers to "how is it going" in 40 vertical pixels. `Sparkline`
  // itself is untouched and still covered by `sparkline.test.tsx` and the Activity page, which is
  // where a ten-minute histogram has the width to be read.

  // Motion pass (spec §8 / M4 deferral). jsdom can't see the animation itself, so these pin the
  // mechanism the CSS relies on: a key that remounts on text change (fresh DOM node → the
  // cross-fade keyframe replays), a status-flash trigger with its motion-safe class and timed
  // decay, and the `motion-safe:` variant gating every animation class for reduced-motion.
  describe('motion (spec §8)', () => {
    it("cross-fades the action line via a key that remounts when the line's text changes", () => {
      const { container, rerender } = render(
        <AgentCard agent={agent({ status: 'working', actionLine: 'Read a.ts' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />,
      )
      const first = container.querySelector('[data-testid="action-line"] > span')
      expect(first).toBeTruthy()
      expect(first?.className).toContain('motion-safe:animate-[action-line-in_120ms_ease-out]')

      rerender(<AgentCard agent={agent({ status: 'working', actionLine: 'Write b.ts' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
      const second = container.querySelector('[data-testid="action-line"] > span')
      // A different key means React unmounts the old span and mounts a new DOM node — that
      // remount is what makes the cross-fade keyframe run again on every text change.
      expect(second).not.toBe(first)
      expect(second?.textContent).toBe('Write b.ts')
    })

    it('carries data-status and a transition-colors border, ready for the flash to animate against', () => {
      const { container } = render(<AgentCard agent={agent({ status: 'working' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
      const card = container.querySelector('article')
      expect(card?.getAttribute('data-status')).toBe('working')
      expect(card?.className).toContain('transition-colors')
    })

    it('flashes the border motion-safe class on a status change and clears it after 800ms', () => {
      vi.useFakeTimers()
      try {
        const { container, rerender } = render(<AgentCard agent={agent({ status: 'working' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
        const card = () => container.querySelector('article')!
        // No status change yet (this is the initial mount) — no flash.
        expect(card().className).not.toContain('motion-safe:animate-[border-flash_800ms_ease-out]')

        rerender(<AgentCard agent={agent({ status: 'paused' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
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

describe('AgentCard — the handoff anatomy', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the header: avatar tile, name, role, status pill', () => {
    render(
      <AgentCard
        agent={agent({ name: 'Alex Turner', role: 'backend', status: 'working', taskStatus: 'running' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('avatar-tile').textContent).toBe('AT')
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('working')
  })

  // The ten states, exhaustively — spec §3's "AgentCard renders all ten states in one it.each".
  const TEN: ReadonlyArray<readonly [AgentCardData['status'], TaskStatus | null, string, string]> = [
    ['working', 'running', 'WORKING', 'working'],
    ['starting', 'assigned', 'PLANNING', 'planning'],
    ['stopping', 'running', 'WAITING', 'waiting'],
    ['working', 'reviewing', 'REVIEW', 'review'],
    ['paused', 'running', 'PAUSED', 'paused'],
    ['pausing', 'running', 'PAUSING', 'waiting'],
    ['resuming', 'running', 'RESUMING', 'working'],
    ['idle', 'blocked', 'BLOCKED', 'blocked'],
    ['idle', null, 'IDLE', 'idle'],
    ['idle', 'done', 'DONE', 'done'],
  ]

  it.each(TEN)('renders %s + task %s as the %s pill in the %s tone', (status, taskStatus, label, tone) => {
    render(
      <AgentCard
        agent={agent({ status, taskStatus, taskTitle: 'Add the thing' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    const pill = screen.getByTestId('status-pill')
    expect(pill.textContent).toBe(label)
    expect(pill.getAttribute('data-tone')).toBe(tone)
  })

  it('carries the handoff surface recipe: radius 8, padding 12/13, hover border', () => {
    render(<AgentCard agent={agent({})} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    const card = screen.getByTestId('agent-card')
    // Class strings, not computed style: jsdom loads no CSS in this suite. The gate reads
    // `border-radius: 8px` and `padding: 12px 13px` back off the real page.
    expect(card.className).toContain('rounded-card')
    expect(card.className).toContain('px-[13px]')
    expect(card.className).toContain('py-[12px]')
    expect(card.className).toContain('hover:border-white/20')
    // The README's 3px bar, the one number the first round left at `ProgressBar`'s 6px default.
    expect(screen.getByTestId('progress-bar').className).toContain('h-[3px]')
  })

  it('sweeps the top hairline only while working', () => {
    const { rerender } = render(
      <AgentCard agent={agent({ status: 'working', taskStatus: 'running' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />,
    )
    expect(screen.getByTestId('card-sweep').className).toContain('motion-safe:animate-[card-sweep_2.2s_cubic-bezier(.4,0,.2,1)_infinite]')

    rerender(<AgentCard agent={agent({ status: 'paused', taskStatus: 'running' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.queryByTestId('card-sweep')).toBeNull()
  })

  it('renders the task line as a mono reference plus an ellipsised title', () => {
    render(
      <AgentCard
        agent={agent({ taskId: '3f9a21c8-0000-4000-8000-000000000000', taskTitle: 'Implement Checkout API', taskStatus: 'running', status: 'working' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('card-task-ref').textContent).toBe('TASK-3f9a21c8')
    expect(screen.getByTestId('card-task-title').className).toContain('truncate')
  })

  it('shows the step counter and percent from the run, and — with no run', () => {
    const { rerender } = render(
      <AgentCard agent={agent({ status: 'working', taskStatus: 'running', progressPct: 64, stepLabel: '7/11' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />,
    )
    expect(screen.getByTestId('card-step').textContent).toBe('7/11')
    expect(screen.getByTestId('card-percent').textContent).toBe('64%')
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('64%')

    rerender(<AgentCard agent={agent({ status: 'idle' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.getByTestId('card-step').textContent).toBe('—')
  })

  it('renders the three chips: skill, queue, provider — each with its own unknown mark', () => {
    const { rerender } = render(
      <AgentCard
        agent={agent({ skill: 'superpowers:test-driven-development', queuedMessage: 'rebase first', provider: 'cursor' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('card-skill-chip').textContent).toBe('superpowers:test-driven-development')
    expect(screen.getByTestId('card-queue-chip').textContent).toBe('queued')
    expect(screen.getByTestId('provider-chip').textContent).toBe('cursor')

    rerender(<AgentCard agent={agent({ skill: null, queuedMessage: null, provider: null })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.getByTestId('card-skill-chip').textContent).toBe('—')
    expect(screen.getByTestId('card-queue-chip').textContent).toBe('—')
    expect(screen.getByTestId('provider-chip').textContent).toBe('—')
  })

  it('POSTs pause to the run route the panel already uses', async (): Promise<void> => {
    render(
      <AgentCard
        agent={agent({ status: 'working', taskStatus: 'running', runId: 'r1' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-pause'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/pause', { method: 'POST' })
  })

  it('swaps pause for resume once the run is paused', async (): Promise<void> => {
    render(
      <AgentCard agent={agent({ status: 'paused', taskStatus: 'running', runId: 'r1' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />,
    )
    expect(screen.queryByTestId('card-pause')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-resume'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/resume', { method: 'POST' })
  })

  it('cannot ask for the same resume twice: a pending request disables Resume and says so', () => {
    // `AgentPanel.tsx`'s guard, mirrored: the intent is a single `resumeRequestedAt` column, so a
    // second click cannot mean anything the first did not already say. Same wording as the panel.
    const { rerender } = render(
      <AgentCard
        agent={agent({ status: 'paused', taskStatus: 'running', runId: 'r1', resumeRequestedAt: '2026-08-29T09:00:00.000Z' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect((screen.getByTestId('card-resume') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('card-resume-requested').textContent).toBe('resume requested — waiting for the daemon')

    rerender(
      <AgentCard
        agent={agent({ status: 'paused', taskStatus: 'running', runId: 'r1', resumeRequestedAt: null })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect((screen.getByTestId('card-resume') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('card-resume-requested')).toBeNull()
  })

  it('POSTs stop, and opens the panel for Message rather than inventing a second textarea', async (): Promise<void> => {
    const onOpen = vi.fn()
    render(
      <AgentCard agent={agent({ status: 'working', taskStatus: 'running', runId: 'r1' })} liveActionLine={null} workspaceId="w1" onOpen={onOpen} />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-stop'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/stop', { method: 'POST' })

    fireEvent.click(screen.getByTestId('card-message'))
    expect(onOpen).toHaveBeenCalledWith('a1')
  })

  it('disables every footer control when there is no run to control', () => {
    render(<AgentCard agent={agent({ status: 'idle', runId: null })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect((screen.getByTestId('card-pause') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('card-stop') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a refusal verbatim without touching the snapshot', async (): Promise<void> => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'the run is still stopping; retry in a moment' }), { status: 409 }),
    )
    render(
      <AgentCard agent={agent({ status: 'paused', taskStatus: 'running', runId: 'r1' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-resume'))
    })
    expect(screen.getByTestId('card-error').textContent).toBe('the run is still stopping; retry in a moment')
  })
})

describe('Overview bottom row', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists a blocked task and offers resume on a paused run', () => {
    const view = {
      ...snapshot([]),
      blocked: [
        { kind: 'task' as const, id: 't1', title: 'Payment provider keys', detail: 'blocked', action: null, runId: null },
        { kind: 'run' as const, id: 'r1', title: 'Alex', detail: 'paused at step 7', action: 'resume' as const, runId: 'r1' },
      ],
    }
    render(<BlockedPanel workspaceId="w1" items={view.blocked} />)
    expect(screen.getAllByTestId('blocked-row')).toHaveLength(2)
    expect(screen.getAllByTestId('blocked-row')[1]?.textContent).toContain('paused at step 7')
    expect(screen.getByTestId('blocked-resume')).toBeTruthy()
  })

  it('offers no resume on a task, and none on a run that has only been ASKED to pause', () => {
    // `requestResume` refuses a `pause_requested` run — there is no checkpoint to resume from
    // yet. A button that always refuses is worse than no button, so the panel reports and waits.
    render(
      <BlockedPanel
        workspaceId="w1"
        items={[
          { kind: 'task', id: 't1', title: 'Payment provider keys', detail: 'blocked', action: null, runId: null },
          { kind: 'run', id: 'r2', title: 'Sam', detail: 'pause requested', action: null, runId: null },
        ]}
      />,
    )
    expect(screen.queryByTestId('blocked-resume')).toBeNull()
  })

  it('POSTs resume to the run route the card and panel already use, and shows a refusal verbatim', async (): Promise<void> => {
    render(
      <BlockedPanel
        workspaceId="w1"
        items={[{ kind: 'run', id: 'r1', title: 'Alex', detail: 'paused at step 7', action: 'resume', runId: 'r1' }]}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('blocked-resume'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/resume', { method: 'POST' })

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'the run is still stopping; retry in a moment' }), { status: 409 }),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('blocked-resume'))
    })
    expect(screen.getByTestId('blocked-error').textContent).toBe('the run is still stopping; retry in a moment')
  })

  it('says nothing needs you rather than drawing an empty list', () => {
    render(<BlockedPanel workspaceId="w1" items={[]} />)
    expect(screen.getByTestId('blocked-empty').textContent).toBe('nothing needs you')
    expect(screen.queryByTestId('blocked-row')).toBeNull()
  })

  it('renders the 340px live-events panel with an all → action', () => {
    render(<LiveEventsPanel workspaceId="w1" events={[{ seq: 9, ts: '2026-08-29T10:00:00.000Z', summary: 'Alex wrote a.txt' }]} />)
    expect(screen.getByTestId('live-events').className).toContain('w-[340px]')
    expect(screen.getByTestId('panel-header-action').textContent).toBe('all →')
    expect(screen.getAllByTestId('live-event-row')).toHaveLength(1)
    // The clock, not the whole ISO stamp — the handoff's events panel is a mono time column.
    expect(screen.getAllByTestId('live-event-row')[0]?.textContent).toContain('10:00:00')
  })

  it('points all → at this workspace\'s Activity page', () => {
    render(<LiveEventsPanel workspaceId="w1" events={[]} />)
    expect(screen.getByTestId('panel-header-action').querySelector('a')?.getAttribute('href')).toBe('/w/w1/activity')
    expect(screen.getByTestId('live-events-empty').textContent).toBe('no events yet')
  })

  it('gives a new live-events row the rise class and an existing one none', () => {
    const { rerender } = render(<LiveEventsPanel workspaceId="w1" events={[{ seq: 1, ts: '2026-08-29T10:00:00.000Z', summary: 'a' }]} />)
    rerender(
      <LiveEventsPanel
        workspaceId="w1"
        events={[
          { seq: 2, ts: '2026-08-29T10:00:01.000Z', summary: 'b' },
          { seq: 1, ts: '2026-08-29T10:00:00.000Z', summary: 'a' },
        ]}
      />,
    )
    const rows = screen.getAllByTestId('live-event-row')
    expect(rows[0]?.className).toContain('motion-safe:animate-[rise_0.3s_ease-out]')
    expect(rows[1]?.className).not.toContain('animate-[rise')
  })

  it('lists the merge queue FIFO and says nothing when it is empty', () => {
    const { rerender } = render(
      <MergeQueuePanel queue={[{ id: 't1', title: 'API contract', hasApproval: true }, { id: 't2', title: 'Checkout UI', hasApproval: true }]} />,
    )
    expect(screen.getAllByTestId('merge-row').map((r) => r.textContent)).toEqual(['API contract', 'Checkout UI'])

    rerender(<MergeQueuePanel queue={[]} />)
    expect(screen.getByTestId('merge-empty').textContent).toBe('nothing in the queue')
  })

  // Coordinator ruling (b): the merge pass SKIPS a `merging` task with no `task.review_approved`
  // event — it will never be picked up. The panel still lists it, last, and says why, because a
  // task stuck in the queue is exactly what an operator opened this panel to find.
  it('marks a queued task the merge pass will never pick up, and leaves the rest unmarked', () => {
    render(
      <MergeQueuePanel
        queue={[
          { id: 't1', title: 'API contract', hasApproval: true },
          { id: 't2', title: 'Hand-moved task', hasApproval: false },
        ]}
      />,
    )
    expect(screen.getAllByTestId('merge-row').map((r) => r.textContent)).toEqual([
      'API contract',
      'Hand-moved taskno approval',
    ])
    const marks = screen.getAllByTestId('merge-queue-no-approval')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe('no approval')
  })
})

describe('ShellFactsContext', () => {
  // Controller ruling carried from Task 3: the root layout's `Sidebar` opens its own
  // `EventSource` per workspace page, which is a SECOND stream on every page that already has
  // one. A page that has the facts provides them; the sidebar falls back to its own stream only
  // where nobody does. Task 12 removes the fallback.
  beforeEach((): void => {
    FakeShellEventSource.instances = []
    vi.stubGlobal('EventSource', FakeShellEventSource as unknown as typeof EventSource)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })

  afterEach((): void => {
    vi.unstubAllGlobals()
  })

  it('paints the nav badges and guardrails from the provider, opening no stream of its own', () => {
    render(
      <ShellFactsProvider
        value={{
          facts: {
            workspace: { id: 'w1', name: 'Checkout' },
            counts: { agentsWorking: 2, tasksActive: 5 },
            guardrails: { budgetUsd: 100, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
          },
          latencyMs: 12,
        }}
      >
        <ProjectNav workspaceId="w1" pathname="/w/w1" />
      </ShellFactsProvider>,
    )
    expect(screen.getByTestId('nav-badge-Agents').textContent).toBe('2')
    expect(screen.getByTestId('nav-badge-Tasks').textContent).toBe('5')
    expect(screen.getByTestId('guardrail-budget').textContent).toBe('$100.00')
    expect(screen.getByTestId('guardrail-timeout').textContent).toBe('30m')
    expect(FakeShellEventSource.instances).toHaveLength(0)
  })

  it('falls back to its own stream when no provider is mounted above it', () => {
    render(<ProjectNav workspaceId="w1" pathname="/w/w1" />)
    // The M14 Task 3 behaviour, unchanged where nothing provides the facts: one stream, and every
    // figure reads the unknown mark until the first snapshot lands.
    expect(FakeShellEventSource.instances).toHaveLength(1)
    expect(screen.getByTestId('nav-badge-Agents').textContent).toBe('—')
  })
})

/** Minimal `EventSource` stand-in (`shell.test.tsx`'s precedent) — these tests are about whether
 *  one gets OPENED at all, so it only has to count constructions. */
class FakeShellEventSource {
  static instances: FakeShellEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(public url: string) {
    FakeShellEventSource.instances.push(this)
  }
  close(): void {}
}
