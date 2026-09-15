// @vitest-environment jsdom
import type { TaskStatus } from '@slave-of-ai/domain'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { SlaveCard } from '../src/components/SlaveCard.js'
import { HaltBanner } from '../src/components/HaltBanner.js'
import { LiveEventsPanel, MergeQueuePanel, OverviewClient } from '../src/components/OverviewClient.js'
import { TasksClient } from '../src/components/TasksClient.js'
import { publishStreamState } from '../src/hooks/useStreamState.js'
import { RightPanel } from '../src/components/shell/RightPanel.js'
import { RightPanelProvider } from '../src/components/shell/RightPanelProvider.js'
import { taskItem } from './fixtures/taskItem.js'
import type { SlaveCardData, OverviewSnapshot } from '../src/server/overview.js'
import type { TasksSnapshot } from '../src/server/tasks.js'

// Module-level so the T5-1 case below can assert which URLs `useSelectedId` wrote -- a fresh
// `vi.fn()` returned from inside `useRouter` gives an assertion no stable reference to check.
const routerReplace = vi.fn()

// `OverviewClient`'s `useSelectedId` reads the router.
vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../src/hooks/useStreamState', () => ({ publishStreamState: vi.fn() }))

/** Every page client in the shell runs inside the root layout's providers, and beside the SLOT
 *  those providers feed. A test that renders one bare is rendering a tree that does not exist --
 *  `useRightPanel` says so by throwing, and a selected task or worker would have nowhere to be
 *  drawn (M57 R8: the page mirrors its selection into the slot, it no longer draws the panel). */
function renderInShell(ui: React.ReactElement): ReturnType<typeof render> {
  return render(
    <RightPanelProvider>
      {ui}
      <RightPanel title="Supervisor">{null}</RightPanel>
    </RightPanelProvider>,
  )
}

const slave = (over: Partial<SlaveCardData>): SlaveCardData => ({
  id: 'a1',
  personId: 'p1',
  name: 'Alex',
  role: 'backend',
  // M12 Task 9 / ruling R10: `'claude_code'` is the `ProviderKind` (the column). The old value
  // here, `'claude-code'`, was the ADAPTER ID -- a spelling no row ever held, from before
  // `overview.ts` had a real column to read.
  provider: 'claude_code',
  // `capabilitiesOf('claude_code').gate` (M12 Task 13 fix round 1, spec §8 / finding 4a) --
  // paired with the default `provider` above the same way `SlaveCardData.gate` is server-derived
  // from `SlaveCardData.provider`, never a second table.
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
  waitingFor: null,
  // M37 t4: the persona and the dispatchable role set. The card's own M37 assertions below set
  // `runtimeRoles` per case; this default is the parked worker.
  profile: null,
  runtimeRoles: [],
  // M50 R1/R3: why this worker is here, and whether the engagement is over. `project` is the
  // ordinary hire and prints no chip at all, so the cases that want one state their own.
  lifecycle: 'project',
  released: null,
  // M52 R7: what this worker may do. The card shows none of it; `SlavePanel` is the surface.
  permissions: [],
  permissionsRunKind: 'implementation',
  // M51 R7: the rung the behavioural breaker has this worker's live run on. `none` is every
  // healthy worker, and it is what the card says nothing about.
  breakerLevel: 'none',
  ...over,
})

const snapshot = (slaves: readonly SlaveCardData[]): OverviewSnapshot => ({
  workspace: {
    id: 'w1', name: 'W', haltedReason: null, haltedAt: null, budgetUsd: 100, spentUsd: 3, unmeasuredRuns: 0,
    // M38 t5: the Supervisor's share of `spentUsd`. Nothing here, so the strip claims nothing --
    // the two cases that do are below.
    supervisorSpend: { measuredUsd: 0, unmeasuredCalls: 0 },
    goal: null, goalVersion: 0, provider: 'claude_code', costBlindBudgeted: false,
    // M14 Task 8: the three guardrail columns the project header/tab strip read (M24 §2.2). They
    // live on the overview snapshot so the page can PROVIDE `ShellFacts` from the stream it
    // already has, rather than the header opening a second `EventSource` of its own.
    maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3,
    // M33 §4: null in the shared fixture -- a workspace assigned by hand, exactly like every
    // other fixture-made workspace before this milestone. Adoption's own note is exercised by a
    // dedicated test below rather than by widening this default.
    adoptedFrom: null,
  },
  slaves,
  tasks: { active: 2, ready: 3, blocked: 1, done: 4, failed: 0 },
  blocked: [],
  liveEvents: [],
  mergeQueue: [],
  // M45 R1/R2: the brief, the needs-you queue and the timeline ride on this snapshot (plan
  // erratum E19). Empty here -- this fixture asserts nothing about them.
  brief: {
    objective: { text: null, version: 0 },
    supervisor: { state: 'idle', label: 'IDLE', needsYou: false },
    work: { working: 0, verifying: 0, review: 0, waiting: 0, done: 0 },
    team: [],
    needsYou: [],
    latestVerified: null,
    cost: { spentUsd: 0, measuredUsd: 0, actualUsd: 0, estimatedUsd: 0, upperBoundUsd: 0, unmeasuredCalls: 0, unmeasuredRuns: 0, budgetUsd: null },
    recentChanges: [],
    knowledge: { verified: 0, candidates: 0 },
  },
  needsYou: [],
  timeline: [],
  // M48 R7: a project that has adopted nothing and has nothing to recommend renders no panel at
  // all -- which is what every case in this file is about the absence of.
  runbook: null,
})

describe('SlaveCard', () => {
  it('shows a working slave with the task it is on', () => {
    render(
      <SlaveCard
        slave={slave({ status: 'working', taskTitle: 'Add the thing', actionLine: 'Read a.ts' })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    // M57 R18: the live action line is the PANEL's now -- a row says which TASK a worker is on,
    // not which file it is reading.
    expect(screen.queryByTestId('action-line')).toBeNull()
    expect(screen.getByText('Add the thing')).toBeTruthy()
    // M14 Task 2: the card says its state in the handoff's `StatusPill` vocabulary now, not the
    // raw `SlaveStatus` word the M5 card printed into `status-label`.
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')
  })

  // M51 R7: the run is still WORKING and the breaker is speaking to it. The word is the difference
  // and the tone is not -- nothing needs a person, so this must not read as a red BLOCKED.
  it('says STEERED and CONSTRAINED for a run the breaker has spoken to', () => {
    const { rerender } = render(
      <SlaveCard
        slave={slave({ status: 'working', taskStatus: 'running', breakerLevel: 'steered' })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('status-pill').textContent).toBe('STEERED')
    rerender(
      <SlaveCard
        slave={slave({ status: 'working', taskStatus: 'running', breakerLevel: 'constrained' })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('status-pill').textContent).toBe('CONSTRAINED')
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('waiting')
  })

  it('keeps the word somebody else produced on a worker that is not working', () => {
    render(
      <SlaveCard
        slave={slave({ status: 'paused', taskStatus: 'running', breakerLevel: 'constrained' })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('status-pill').textContent).toBe('PAUSED')
  })

  it('pulses only while working', () => {
    // M14 Task 2: the dot moved inside `StatusPill` (its first child) and the keyframe is the
    // shared `status-pulse` one, not Tailwind's `animate-pulse`. The rule is unchanged.
    const dot = (): Element => screen.getByTestId('status-pill').firstElementChild as Element
    const { rerender } = render(<SlaveCard slave={slave({ status: 'working' })} workspaceId="w1" onOpen={() => {}} />)
    expect(dot().className).toContain('motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]')
    rerender(<SlaveCard slave={slave({ status: 'paused' })} workspaceId="w1" onOpen={() => {}} />)
    // Motion carries information (spec §7): a pulsing paused slave is a lie on screen.
    expect(dot().className).not.toContain('status-pulse')
  })

  // M36 t2 fix round 1, finding 1: a waiting run is `paused`, and a footer offering a bare
  // "Resume" told an operator to continue a slave whose question nobody had answered.
  describe('a slave waiting for another slave (M36 t2)', () => {
    const waiting = slave({
      status: 'paused',
      waitingFor: { recipient: 'Maya', question: 'Which queue should retries land on?', messageId: 'm-1' },
    })

    it('offers Answer instead of Resume, and Answer opens the panel where an answer can be typed', () => {
      const onOpen = vi.fn()
      render(<SlaveCard slave={waiting} workspaceId="w1" onOpen={onOpen} />)
      expect(screen.queryByTestId('card-resume')).toBeNull()
      fireEvent.click(screen.getByTestId('card-answer'))
      expect(onOpen).toHaveBeenCalledWith('p1')
    })

    it('still offers Resume for an ordinary operator pause', () => {
      render(<SlaveCard slave={slave({ status: 'paused' })} workspaceId="w1" onOpen={() => {}} />)
      expect(screen.getByTestId('card-resume')).toBeTruthy()
      expect(screen.queryByTestId('card-answer')).toBeNull()
    })
  })

  it('opens the detail panel via onOpen when the header is clicked — no more disabled M4 buttons', () => {
    const onOpen = vi.fn()
    render(<SlaveCard slave={slave({ id: 'a9', status: 'working' })} workspaceId="w1" onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /open alex's detail panel/i }))
    expect(onOpen).toHaveBeenCalledWith('p1')
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
    it('carries data-status and a transition-colors border, ready for the flash to animate against', () => {
      const { container } = render(<SlaveCard slave={slave({ status: 'working' })} workspaceId="w1" onOpen={() => {}} />)
      const card = container.querySelector('article')
      expect(card?.getAttribute('data-status')).toBe('working')
      expect(card?.className).toContain('transition-colors')
    })

    it('flashes the border motion-safe class on a status change and clears it after 800ms', () => {
      vi.useFakeTimers()
      try {
        const { container, rerender } = render(<SlaveCard slave={slave({ status: 'working' })} workspaceId="w1" onOpen={() => {}} />)
        const card = () => container.querySelector('article')!
        // No status change yet (this is the initial mount) — no flash.
        expect(card().className).not.toContain('motion-safe:animate-[border-flash_800ms_ease-out]')

        rerender(<SlaveCard slave={slave({ status: 'paused' })} workspaceId="w1" onOpen={() => {}} />)
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

describe('SlaveCard — the handoff anatomy', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the row head: a 30px avatar tile, name, role, status pill', () => {
    render(
      <SlaveCard
        slave={slave({ name: 'Alex Turner', role: 'backend', status: 'working', taskStatus: 'running' })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('avatar-tile').textContent).toBe('AT')
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('working')
    // Ruling P8: the Team row is the one caller that asks `AvatarTile` for the README's 30px. The
    // prop DEFAULTS to the 28px the five other surfaces render, so none of them moved.
    const tile = screen.getByTestId('avatar-tile')
    expect(tile.getAttribute('data-size')).toBe('md')
    expect(tile.className).toContain('h-[30px]')
  })

  // The ten states, exhaustively — spec §3's "SlaveCard renders all ten states in one it.each".
  const TEN: ReadonlyArray<readonly [SlaveCardData['status'], TaskStatus | null, string, string]> = [
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
      <SlaveCard
        slave={slave({ status, taskStatus, taskTitle: 'Add the thing' })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    const pill = screen.getByTestId('status-pill')
    expect(pill.textContent).toBe(label)
    expect(pill.getAttribute('data-tone')).toBe(tone)
  })

  it('is a row on the README grid, with one primary button and a ⋯ (M57 R18)', () => {
    render(<SlaveCard slave={slave({})} workspaceId="w1" onOpen={vi.fn()} />)
    const row = screen.getByTestId('slave-card')
    // Class strings, not computed style: jsdom loads no CSS in this suite. The gate reads the
    // six track widths and the `10px 14px` padding back off the real page.
    expect(row.className).toContain('grid-cols-[34px_120px_120px_minmax(0,1fr)_96px_32px]')
    expect(row.className).toContain('px-[14px]')
    expect(row.className).toContain('py-[10px]')
    // A ROW is not a bordered card: one hairline underneath, and the tone reads off the avatar
    // tile and the status word instead of a per-state border.
    expect(row.className).toContain('border-b')
    expect(row.className).not.toContain('rounded-card')

    expect(screen.getByTestId('card-pause')).toBeTruthy()
    expect(screen.getByTestId('card-more').textContent).toBe('⋯')
    // Message and Stop are `SlavePanel`'s, which is what the `⋯` opens.
    expect(screen.queryByTestId('card-stop')).toBeNull()
    expect(screen.queryByTestId('card-message')).toBeNull()
    // The README's 3px bar stays on the row (ruling P26): the panel draws no progress at all.
    expect(screen.getByTestId('progress-bar').className).toContain('h-[3px]')
  })

  // M57 R18 / ruling P7: the README's Unblock is about a blocked TASK. `SlaveCardData.status` has
  // no `blocked` member at all -- an IDLE worker whose task is blocked is the state that needs a
  // person, and `Unblock` opens the panel where the task can be read and unblocked.
  it('offers Unblock on a blocked TASK, never on a worker status', () => {
    const onOpen = vi.fn()
    render(<SlaveCard slave={slave({ status: 'idle', taskStatus: 'blocked' })} workspaceId="w1" onOpen={onOpen} />)
    expect(screen.queryByTestId('card-pause')).toBeNull()
    fireEvent.click(screen.getByTestId('card-unblock'))
    expect(onOpen).toHaveBeenCalledWith('p1')
  })

  it('sweeps the top hairline only while working', () => {
    const { rerender } = render(
      <SlaveCard slave={slave({ status: 'working', taskStatus: 'running' })} workspaceId="w1" onOpen={() => {}} />,
    )
    expect(screen.getByTestId('card-sweep').className).toContain('motion-safe:animate-[card-sweep_2.2s_cubic-bezier(.4,0,.2,1)_infinite]')

    rerender(<SlaveCard slave={slave({ status: 'paused', taskStatus: 'running' })} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.queryByTestId('card-sweep')).toBeNull()
  })

  // M57 R18: ONE line for the task, with the mono reference folded into it -- `card-task-ref` was
  // its own node while this was a card, and the id is `SlavePanel`'s now.
  it('renders the task title and its mono reference on one ellipsised line', () => {
    render(
      <SlaveCard
        slave={slave({ taskId: '3f9a21c8-0000-4000-8000-000000000000', taskTitle: 'Implement Checkout API', taskStatus: 'running', status: 'working' })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    const line = screen.getByTestId('card-task-title')
    expect(line.textContent).toBe('Implement Checkout APITASK-3f9a21c8')
    expect(line.className).toContain('truncate')
    expect(screen.queryByTestId('card-task-ref')).toBeNull()
  })

  // The step counter and the percent READING left with the card; the bar itself stays (ruling
  // P26), because `SlavePanel` draws no progress of any kind and a fact with nowhere to go stays.
  it('draws the run s progress as the bar, and leaves the counter to the panel', () => {
    render(
      <SlaveCard slave={slave({ status: 'working', taskStatus: 'running', progressPct: 64, stepLabel: '7/11' })} workspaceId="w1" onOpen={() => {}} />,
    )
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('64%')
    expect(screen.queryByTestId('card-step')).toBeNull()
    expect(screen.queryByTestId('card-percent')).toBeNull()
  })

  // M50 R6, `docs/ia.md` rule 3: the word, with the raw value one hover away. `project` is the
  // ordinary case and prints nothing -- a chip every card carries marks nothing.
  it('marks a temporary specialist, and greys the row of one whose engagement is over', () => {
    const { rerender } = render(<SlaveCard slave={slave({})} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.queryByTestId('card-lifecycle-chip')).toBeNull()
    expect(screen.getByTestId('slave-card').getAttribute('data-released')).toBeNull()

    rerender(<SlaveCard slave={slave({ lifecycle: 'ephemeral' })} workspaceId="w1" onOpen={() => {}} />)
    const chip = screen.getByTestId('card-lifecycle-chip')
    expect(chip.textContent).toBe('Ephemeral')
    // The WORD, with the raw value one hover away -- on the marker itself, now that the row draws
    // its own instead of wrapping `ui/Chip`.
    expect(chip.getAttribute('title')).toBe('ephemeral')

    rerender(
      <SlaveCard
        slave={slave({ lifecycle: 'ephemeral', released: { at: '2026-09-12T10:00:00.000Z', reason: 'over' } })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    const card = screen.getByTestId('slave-card')
    expect(card.getAttribute('data-released')).toBe('true')
    expect(card.className).toContain('opacity-60')
  })

  it('POSTs pause to the run route the panel already uses', async (): Promise<void> => {
    render(
      <SlaveCard
        slave={slave({ status: 'working', taskStatus: 'running', runId: 'r1' })}
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
      <SlaveCard slave={slave({ status: 'paused', taskStatus: 'running', runId: 'r1' })} workspaceId="w1" onOpen={() => {}} />,
    )
    expect(screen.queryByTestId('card-pause')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-resume'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/resume', { method: 'POST' })
  })

  it('cannot ask for the same resume twice: a pending request disables Resume', () => {
    // `SlavePanel.tsx`'s guard, mirrored: the intent is a single `resumeRequestedAt` column, so a
    // second click cannot mean anything the first did not already say. Same wording as the panel.
    const { rerender } = render(
      <SlaveCard
        slave={slave({ status: 'paused', taskStatus: 'running', runId: 'r1', resumeRequestedAt: '2026-08-29T09:00:00.000Z' })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect((screen.getByTestId('card-resume') as HTMLButtonElement).disabled).toBe(true)
    // The SENTENCE that explains the disabled button is `SlavePanel`'s `resume-requested`, which
    // this row's name and its `⋯` both open (M57 R18).
    expect(screen.queryByTestId('card-resume-requested')).toBeNull()

    rerender(
      <SlaveCard
        slave={slave({ status: 'paused', taskStatus: 'running', runId: 'r1', resumeRequestedAt: null })}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect((screen.getByTestId('card-resume') as HTMLButtonElement).disabled).toBe(false)
  })

  // M57 R18: Stop and Message left the row for `SlavePanel`, which is what the `⋯` opens. The row
  // POSTs nothing they used to POST, and it invents no second textarea either.
  it('opens the panel from ⋯ instead of carrying Stop and Message', () => {
    const onOpen = vi.fn()
    render(
      <SlaveCard slave={slave({ status: 'working', taskStatus: 'running', runId: 'r1' })} workspaceId="w1" onOpen={onOpen} />,
    )
    fireEvent.click(screen.getByTestId('card-more'))
    expect(onOpen).toHaveBeenCalledWith('p1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('disables its one control when there is no run to control', () => {
    render(<SlaveCard slave={slave({ status: 'idle', runId: null })} workspaceId="w1" onOpen={() => {}} />)
    expect((screen.getByTestId('card-pause') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a refusal verbatim without touching the snapshot', async (): Promise<void> => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'the run is still stopping; retry in a moment' }), { status: 409 }),
    )
    render(
      <SlaveCard slave={slave({ status: 'paused', taskStatus: 'running', runId: 'r1' })} workspaceId="w1" onOpen={() => {}} />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-resume'))
    })
    expect(screen.getByTestId('card-error').textContent).toBe('the run is still stopping; retry in a moment')
  })
})

describe('Overview bottom row', () => {
  it('renders the 340px live-events panel with an all → action', () => {
    render(<LiveEventsPanel workspaceId="w1" events={[{ seq: 9, ts: '2026-08-29T10:00:00.000Z', type: 'run.tool_result', summary: 'Alex wrote a.txt' }]} />)
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
    const { rerender } = render(<LiveEventsPanel workspaceId="w1" events={[{ seq: 1, ts: '2026-08-29T10:00:00.000Z', type: 'run.started', summary: 'a' }]} />)
    rerender(
      <LiveEventsPanel
        workspaceId="w1"
        events={[
          { seq: 2, ts: '2026-08-29T10:00:01.000Z', type: 'run.started', summary: 'b' },
          { seq: 1, ts: '2026-08-29T10:00:00.000Z', type: 'run.started', summary: 'a' },
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

describe('shell facts and stream state reach the project header, never the sidebar', () => {
  // Fix round 1, Critical (carried, re-aimed by M24 §2.2). `app/w/[workspaceId]/layout.tsx`
  // seeds the same store the ROOT layout's header reads, above every page in the tree, so nothing a page
  // mounts can ever be an ancestor of them — the module-level stores (`hooks/useShellFacts.ts`,
  // `hooks/useStreamState.ts`) are how a page's snapshot reaches them anyway. `Sidebar` (rewritten
  // this task) reads none of this any more; its own coverage lives in `shell.test.tsx`.
  class FakeOverviewEventSource {
    static instances: FakeOverviewEventSource[] = []
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onopen: (() => void) | null = null
    constructor(public url: string) {
      FakeOverviewEventSource.instances.push(this)
    }
    close(): void {}
  }

  beforeEach((): void => {
    FakeOverviewEventSource.instances = []
    vi.stubGlobal('EventSource', FakeOverviewEventSource as unknown as typeof EventSource)
  })

  afterEach((): void => {
    vi.unstubAllGlobals()
  })

  it('publishes its stream state on mount, for the project header’s connection chip to read', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={PUBLISHED} />)
    expect(publishStreamState).toHaveBeenCalledWith('w1', { connection: 'connected', latencyMs: null })
  })

  // M24 §3 kept, re-aimed by M57 R17: the goal card and the runtime card left this page for the
  // project Settings tab and are still not here. What changed is the ORDER -- the README's five
  // bands, top to bottom, and the goal is the title row's own line now.
  it('lays the page out in the README s five bands (M57 R17)', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={WAITING} />)
    expect(screen.queryByTestId('goal-input')).toBeNull()
    expect(screen.queryByTestId('runtime-provider')).toBeNull()
    expect(screen.queryByTestId('goal-suggestion')).toBeNull()
    expect(screen.getByTestId('project-goal-line').textContent).toContain('Ship the checkout flow')
    expect(bandOrder()).toEqual(BANDS)
  })

  // M57 R17: FOUR tiles, and the container answers to `strip` as well as `brief` -- `TopStrip` is
  // gone and three gates waited on that marker for "the Overview has rendered".
  it('draws FOUR fact tiles, and the container carries both the brief and the strip testid', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={WAITING} />)
    expect(screen.getAllByTestId('brief-tile').map((tile) => tile.getAttribute('data-brief'))).toEqual([
      'work', 'cost', 'supervisor', 'latest-verified',
    ])
    expect(screen.getByTestId('strip').contains(screen.getByTestId('brief'))).toBe(true)
    expect(screen.queryByTestId('strip-tile')).toBeNull()
  })

  // M57 band 2: the queue that needs a person, above everything the project did on its own.
  it('puts what needs a person on the Needs-you card, above the tiles', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={WAITING} />)
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['decision'])
    expect(screen.getByTestId('needs-you-card').textContent).toContain('Staffing: nobody can review')
    // `BlockedPanel` is deleted (M57 final review I4, dead since Task 6): its three task kinds
    // are this card's, and its paused RUNS are the Team row's own Resume button.
    expect(screen.queryByTestId('blocked-empty')).toBeNull()
  })

  /**
   * M45 R2, at the source (controller ruling T6-1).
   *
   * `run.output` and `run.tool_call` are model chatter, and R2's promise is that their words never
   * reach the project page -- which held only because the river used to sit inside a closed
   * `Advanced` disclosure Task 4 deleted. `buildOverviewSnapshot` excludes the two types in the
   * QUERY now, so `liveEvents` cannot carry one; this case pins the PAGE's half of that contract:
   * it draws what the snapshot gives it, run lifecycle included, without a filter of its own.
   */
  it('draws the live river the snapshot gives it, run lifecycle and all (M45 R2)', () => {
    renderInShell(
      <OverviewClient
        workspaceId="w1"
        initial={{
          ...WAITING,
          liveEvents: [
            { seq: 9, ts: '2026-09-14T10:00:00.000Z', type: 'run.started', summary: 'Runs · started' },
            { seq: 8, ts: '2026-09-14T09:59:00.000Z', type: 'workspace.goal_set', summary: 'Project · goal set' },
          ],
          // The timeline gives `run.started` no lane, so a page that filtered its river against the
          // timeline beside it would drop the run the person is watching. It does not.
          timeline: [],
        }}
      />,
    )
    expect(screen.getAllByTestId('live-event-row').map((row) => row.textContent)).toEqual([
      '10:00:00Runs · started',
      '09:59:00Project · goal set',
    ])
  })

  // M45 erratum E16 kept, re-aimed by M57 R18: the Team band is the same `SlaveCard`s it has
  // always been -- ROWS now, in one surface, listing every worker with a link to the Team page.
  it('M45 E16 / M57 R18: the Team band is the slave rows, counted and linked', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={PUBLISHED} />)
    const team = screen.getByTestId('team')
    expect(team.id).toBe('team') // other surfaces link to #team
    expect(team.textContent).toContain('Team')
    expect(within(team).getByRole('link').getAttribute('href')).toBe('/w/w1/organization')
    expect(team.querySelectorAll('[data-testid="slave-card"]').length).toBe(PUBLISHED.slaves.length)
    expect(screen.getAllByTestId('slave-card').length).toBe(PUBLISHED.slaves.length)
  })

  // Folded review finding: the deleted `team` tile said "nobody works here yet", and a bordered
  // box with nothing in it says nothing at all (`docs/ia.md` rule 2).
  it('says nobody works here yet rather than drawing an empty Team box', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={{ ...PUBLISHED, slaves: [] }} />)
    expect(screen.queryByTestId('slave-card')).toBeNull()
    expect(screen.getByTestId('team-empty').textContent).toContain('nobody works here yet')
    expect(screen.getByTestId('team').textContent).toContain('Team')
  })

  // Ruling T6-3: `requestChange` APPENDS a dated line to the goal on every request, so an unclamped
  // goal line grows without limit and pushes the fact tiles below the 900px fold stage 1 measures.
  it('clamps the goal line to two lines, with the whole of it one hover away', () => {
    const goal = 'Ship the checkout flow.\n\n## Requested changes\n- 2026-09-14: Add Apple Pay'
    renderInShell(
      <OverviewClient
        workspaceId="w1"
        initial={{ ...WAITING, brief: { ...WAITING.brief, objective: { text: goal, version: 2 } } }}
      />,
    )
    const line = screen.getByTestId('project-goal-line')
    expect(line.className).toContain('line-clamp-2')
    expect(line.getAttribute('title')).toBe(goal)
    expect(line.textContent).toContain('Goal v2 ·')
  })

  // M57 R17 band 5 / erratum E17: the Supervisor request BOX is gone -- the right panel's composer
  // is the one box posting to `/goal/request` -- and the six-lane timeline is what Recent changes
  // is made of.
  it('M57: Recent changes IS the timeline, and there is no second Supervisor box', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={PUBLISHED} />)
    expect(screen.queryByTestId('supervisor-request')).toBeNull()
    const changes = screen.getByTestId('recent-changes')
    expect(changes.contains(screen.getByTestId('supervisor-timeline'))).toBe(true)
    expect(screen.getByTestId('supervisor-timeline').contains(screen.getByTestId('timeline'))).toBe(true)
    expect(within(changes).getAllByRole('link').some((one) => one.getAttribute('href') === '/w/w1/activity')).toBe(true)
  })

  // M48 R7: how this project works goes BETWEEN who is doing it and what happened -- and a
  // project nobody has an opinion about (the fixture above) gets no panel at all. Its one-line
  // SUMMARY rides on the Supervisor tile above (M57 R17).
  it('puts the runbook panel between the Team rows and Recent changes, and nothing when there is none', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={PUBLISHED} />)
    expect(screen.queryByTestId('runbook-panel')).toBeNull()

    renderInShell(
      <OverviewClient
        workspaceId="w1"
        initial={{
          ...PUBLISHED,
          runbook: {
            adopted: { key: 'feature-delivery', name: 'Feature delivery', description: 'd', stageCount: 5, source: 'seed', why: null },
            currentStage: 'design',
            stages: [{ key: 'design', title: 'Design', objective: 'Decide', state: 'active', taskCount: 1, capabilities: [] }],
            recommendations: [],
            all: [],
            pendingDecision: null,
          },
        }}
      />,
    )
    expect(bandOrder(screen.getAllByTestId('page-shell')[1] as HTMLElement, ['runbook-panel'])).toEqual([
      'project-title', 'strip', 'team', 'runbook-panel', 'recent-changes',
    ])
    expect(screen.getByTestId('brief-runbook-line').textContent).toBe('Runbook Feature delivery · stage 1/1 Design')
  })

  // M57 R11: the `Advanced ▾` disclosure is gone, and the two panels that stay on this page render
  // directly, inside Recent changes. The `Advanced` link row went with it -- Graph, Office and
  // Analytics are the sidebar tree's `VIEWS` chips now -- and so did the Supervisor panel, which is
  // the right panel's from Task 5 on.
  it('M57 R11: the river and the merge queue render inside Recent changes, with no disclosure to open', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={PUBLISHED} />)
    expect(screen.queryByTestId('overview-advanced')).toBeNull()
    expect(screen.queryByTestId('overview-advanced-toggle')).toBeNull()

    const changes = screen.getByTestId('recent-changes')
    expect(changes.contains(screen.getByTestId('live-events'))).toBe(true)
    expect(screen.getByTestId('live-events').className).toContain('w-[340px]')
    expect(screen.getByText('merge queue · serial')).toBeTruthy()
    expect(screen.getByTestId('merge-empty')).toBeTruthy()
  })

  it('a workspace adopted from a simulation shows the note linking back to it; a hand-assigned one shows nothing (M33 §4)', () => {
    const { unmount } = renderInShell(<OverviewClient workspaceId="w1" initial={PUBLISHED} />)
    expect(screen.queryByTestId('ws-adopted-from')).toBeNull()
    unmount()

    const adopted = { ...PUBLISHED, workspace: { ...PUBLISHED.workspace, adoptedFrom: { simulationId: 's1', name: 'Sprint plan' } } }
    renderInShell(<OverviewClient workspaceId="w2" initial={adopted} />)
    const note = screen.getByTestId('ws-adopted-from')
    expect(note.textContent).toBe('organisation adopted from simulation Sprint plan')
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/sim/s1')
  })

  // M44 Task 4 fix round 1. The provenance line briefly became a `role="alert"` amber band -- a
  // warning about nothing, announced on insertion, sitting in the same colour as the stale-data
  // warning right above it. It is `Alert variant="info"` now: `role="status"`, neutral surface.
  // The second half of this case is the one that would have caught the regression -- with a REAL
  // stale band on screen at the same time, `getByRole('alert')` has to resolve to exactly one node,
  // and it has to be the warning.
  it('says where the organisation came from politely, and leaves role=alert to the actual warning', async (): Promise<void> => {
    vi.useFakeTimers()
    // The stale band is the stream hook's `error`, which only appears when the debounced refetch
    // that follows `onopen` fails -- the one honest way to put both bands on screen at once.
    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const adopted = { ...PUBLISHED, workspace: { ...PUBLISHED.workspace, adoptedFrom: { simulationId: 's1', name: 'Sprint plan' } } }
      renderInShell(<OverviewClient workspaceId="w3" initial={adopted} />)

      const note = screen.getByTestId('ws-adopted-from')
      expect(note.getAttribute('role')).toBe('status')
      expect(note.getAttribute('data-variant')).toBe('info')
      expect(screen.getByRole('status')).toBe(note)
      // Nothing is warning yet, so nothing is an alert yet.
      expect(screen.queryByRole('alert')).toBeNull()

      act((): void => {
        FakeOverviewEventSource.instances[0]?.onopen?.()
      })
      await act(async (): Promise<void> => {
        await vi.advanceTimersByTimeAsync(300)
      })

      // Both bands are on screen. `getByRole` throws on more than one match, so this passing IS
      // the assertion that the provenance line is not competing for the warning's role.
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toContain('showing stale data')
      expect(screen.getByRole('status')).toBe(note)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

/** The snapshot the mount test publishes from: two working slaves, two active tasks. */
const PUBLISHED: OverviewSnapshot = snapshot([
  slave({ id: 'a1', status: 'working' }),
  slave({ id: 'a2', personId: 'p2', name: 'Sam Yates', status: 'working' }),
])

/** The README's five bands, in the order the Overview reads top to bottom (M57 R17). */
const BANDS = ['project-title', 'needs-you-card', 'strip', 'team', 'recent-changes']

/**
 * The bands actually on the page, in DOM order.
 *
 * Over the whole document rather than `page-shell`'s direct children: `needs-you-card` is inside
 * the card's own section, and a band's testid says where the band IS, not how deeply it is nested.
 */
function bandOrder(root: HTMLElement | Document = document, extra: readonly string[] = []): readonly string[] {
  const wanted = [...BANDS, ...extra]
  return [...root.querySelectorAll('[data-testid]')]
    .map((node) => node.getAttribute('data-testid') ?? '')
    .filter((id) => wanted.includes(id))
}

/** A project with something waiting on a person -- the state bands 1 and 2 are about. */
const WAITING: OverviewSnapshot = {
  ...PUBLISHED,
  workspace: { ...PUBLISHED.workspace, name: 'Checkout Platform' },
  needsYou: [
    {
      kind: 'decision', id: 'd-1', title: 'Staffing: nobody can review', href: '/w/w1#decision-d-1',
      since: '2026-09-14T09:00:00.000Z', taskId: null, decisionId: 'd-1', messageId: null,
    },
  ],
  brief: { ...PUBLISHED.brief, objective: { text: 'Ship the checkout flow', version: 2 } },
}

/**
 * M57 R8: the page no longer DRAWS the worker panel -- it mirrors `?slave=` into the shell's slot,
 * and the provider tells the previous owner when a different subject takes that slot (ruling
 * T3-4). The previous owner here is this same page, whose selection has already moved on; a
 * clearer that fired anyway would cancel the click that made the new selection.
 */
describe('the worker panel is mirrored into the slot, not drawn by the page', () => {
  class SilentEventSource {
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onopen: (() => void) | null = null
    close(): void {}
  }

  beforeEach((): void => {
    vi.stubGlobal('EventSource', SilentEventSource as unknown as typeof EventSource)
  })

  afterEach((): void => {
    vi.unstubAllGlobals()
  })

  it('swaps the slot for the next worker instead of closing on itself', () => {
    renderInShell(<OverviewClient workspaceId="w1" initial={PUBLISHED} />)
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('supervisor')

    fireEvent.click(screen.getByRole('button', { name: "Open Alex's detail panel" }))
    const panel = screen.getByTestId('right-panel')
    expect(panel.getAttribute('data-mode')).toBe('slave')
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe('Alex')

    fireEvent.click(screen.getByRole('button', { name: "Open Sam Yates's detail panel" }))
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('slave')
    expect(within(screen.getByTestId('right-panel')).getByRole('heading', { level: 2 }).textContent).toBe('Sam Yates')
  })

  // ---- Ruling T5-1: the provider outlives the page, so the page has to leave cleanly -----------
  //
  // One provider, one slot, and the page under them SWAPPED -- which is what a navigation from
  // `/w/:id` to `/w/:id/tasks` does. Rendered as one tree rather than two `render()` calls,
  // because the whole point is that the provider is the SAME one across the navigation.
  const TASKS: TasksSnapshot = {
    workspace: { id: 'w1', name: 'W', haltedReason: null, goalVersion: 0 },
    shellFacts: {
      workspace: { id: 'w1', name: 'W' },
      counts: { slavesWorking: 0, tasksActive: 0, slavesPaused: 0 },
      guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
      status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
    },
    tasks: [taskItem({ id: 't1' })],
  }

  function Sections({ page }: { readonly page: 'overview' | 'tasks' }): React.JSX.Element {
    return (
      <RightPanelProvider>
        {page === 'overview' ? (
          <OverviewClient workspaceId="w1" initial={PUBLISHED} />
        ) : (
          <TasksClient workspaceId="w1" initial={TASKS} />
        )}
        <RightPanel title="Supervisor">{null}</RightPanel>
      </RightPanelProvider>
    )
  }

  it('hands the slot back when it unmounts, instead of leaving its worker over the next page', () => {
    const { rerender } = render(<Sections page="overview" />)
    fireEvent.click(screen.getByRole('button', { name: "Open Alex's detail panel" }))
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('slave')

    rerender(<Sections page="tasks" />)

    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('supervisor')
    // `panel-close` renders only while a mode is open, so its absence IS "the provider's mode is
    // null" -- read off the slot rather than out of a probe.
    expect(screen.queryByTestId('panel-close')).toBeNull()
    // The worker panel's own `<h2>` is gone from the slot (the board has an `Alex` of its own, on
    // the task card's assignee line, so this is asked of the slot rather than of the document).
    expect(within(screen.getByTestId('right-panel')).queryByRole('heading', { level: 2 })).toBeNull()
  })

  it('does not navigate from the grave when the next page opens something', () => {
    const { rerender } = render(<Sections page="overview" />)
    fireEvent.click(screen.getByRole('button', { name: "Open Alex's detail panel" }))
    rerender(<Sections page="tasks" />)
    routerReplace.mockClear()

    fireEvent.click(screen.getByText('Add the thing'))

    // The task is in the slot, and the dead Overview's clearer did NOT write its own pathname --
    // `select(null)` replaces with the bare path, which is the bounce this ruling is about.
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('task')
    expect(screen.getByTestId('task-panel-ref').textContent).toBe('TASK-t1')
    expect(routerReplace.mock.calls.map((call) => call[0])).not.toContain('/w/w1')
  })
})
