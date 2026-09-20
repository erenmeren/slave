// @vitest-environment jsdom
import type { TaskStatus } from '@slave-of-ai/domain'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { SlaveCard } from '../src/components/SlaveCard.js'
import { HaltBanner } from '../src/components/HaltBanner.js'
import type { SlaveCardData } from '../src/server/overview.js'

/**
 * `SlaveCard` and `HaltBanner`'s own coverage (M61 R7/Task 6), split out of
 * `overview-components.test.tsx` when that file was deleted with `OverviewClient.tsx`.
 *
 * Both components are KEPT by this milestone -- `SlaveCard.tsx`'s own docblock says so, and
 * `HaltBanner` is still rendered by `ProjectSettingsClient.tsx` and `TeamLive.tsx` -- so their
 * regression coverage is kept too, unchanged, rather than deleted along with the page that used
 * to be their only caller. `SlaveCard` itself is no longer rendered by any page as of this task
 * (the Team tab draws `TeamCard` instead); it stays reachable for the panel-launching rows other
 * surfaces may still want, and this file is what proves it still works.
 */

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

