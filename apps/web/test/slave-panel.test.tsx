// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_KINDS } from '@slave-of-ai/domain'
import { SlavePanel } from '../src/components/SlavePanel.js'
import type { SlaveCardData, SlaveFeedEvent } from '../src/server/overview.js'

const slave = (over: Partial<SlaveCardData>): SlaveCardData => ({
  id: 'a1',
  name: 'Alex',
  role: 'backend',
  // M12 Task 9 / ruling R10: `'claude_code'` is the `ProviderKind` (the column). The old value
  // here, `'claude-code'`, was the ADAPTER ID -- a spelling no row ever held, from before
  // `overview.ts` had a real column to read.
  provider: 'claude_code',
  // `capabilitiesOf('claude_code').gate` (M12 Task 13 fix round 1, spec §8 / finding 4a) --
  // paired with the default `provider` above, server-derived in `overview.ts`, never a second
  // table.
  gate: 'all-tools',
  status: 'working',
  taskTitle: 'Add the thing',
  // M14 Task 2 widened `SlaveCardData` with the card's five handoff fields; this fixture
  // states them so it keeps type-checking, and asserts nothing new about them.
  taskId: null,
  taskStatus: null,
  progressPct: 0,
  stepLabel: null,
  skill: null,
  actionLine: null,
  runId: 'r1',
  queuedMessage: null,
  resumeRequestedAt: null,
  recentEvents: [],
  costUsd: 0,
  toolCalls: 0,
  pausedAtStep: null,
  waitingFor: null,
  // M37 t4 widened `SlaveCardData` with the persona and the dispatchable role set; the panel's
  // own M37 block below is what exercises them, so the default here is the empty pair.
  profile: null,
  runtimeRoles: [],
  // M50 R1/R3: why this worker is here, and whether the engagement is over. The panel shows
  // neither; the default is the ordinary project hire.
  lifecycle: 'project' as const,
  released: null,
  // M51 R7: the rung the breaker has this worker's live run on. The panel shows no word off it --
  // the CARD does -- so every case here is the healthy default.
  breakerLevel: 'none' as const,
  // M52 R7: what this worker may do, and the run kind the baselines below were answered for. The
  // empty list is what a panel gets before anything is granted; the permissions describe at the
  // bottom of this file states all six.
  permissions: [],
  permissionsRunKind: 'implementation' as const,
  ...over,
})

const feedEvent = (over: Partial<SlaveFeedEvent>): SlaveFeedEvent => ({
  seq: 1,
  ts: new Date(0).toISOString(),
  type: 'run.tool_call',
  summary: 'Write note.txt',
  ...over,
})

/** Opens one `DetailsGroup` by its `data-group` name (M45 R4). A closed group renders NO children
 *  at all -- that is the primitive's whole contract -- so every case below that reads something now
 *  folded away opens its group first rather than weakening the assertion. */
function openGroup(group: string): void {
  const section = document.querySelector(`[data-testid="details-group"][data-group="${group}"]`)
  const toggle = section?.querySelector('button')
  if (toggle === null || toggle === undefined) throw new Error(`no DetailsGroup named ${group} on screen`)
  fireEvent.click(toggle)
}

describe('SlavePanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('enable/disable matrix', () => {
    it.each(['working', 'starting', 'resuming'] as const)(
      'while %s: pause enabled, resume disabled, stop enabled, message box is a read-only hint',
      (status) => {
        render(
          <SlavePanel
            slave={slave({ status })}
            liveEvents={[]}
            workspaceId="w1"
            haltedReason={null}
            onClose={() => {}}
          />,
        )
        expect(screen.getByTestId('pause-button').getAttribute('disabled')).toBeNull()
        expect(screen.getByTestId('resume-button').getAttribute('disabled')).not.toBeNull()
        expect(screen.getByTestId('stop-button').getAttribute('disabled')).toBeNull()
        // M45 R4: the message box is under the Messages group, which renders on open.
        openGroup('messages')
        expect(screen.getByTestId('message-hint')).toBeTruthy()
        expect(screen.queryByTestId('message-input')).toBeNull()
      },
    )

    it('while paused (workspace not halted): pause disabled, resume enabled, stop enabled, message box writable', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'paused', queuedMessage: 'do the thing' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTestId('resume-button').getAttribute('disabled')).toBeNull()
      expect(screen.getByTestId('stop-button').getAttribute('disabled')).toBeNull()
      openGroup('messages')
      expect(screen.getByTestId('message-input')).toBeTruthy()
      expect(screen.queryByTestId('message-hint')).toBeNull()
    })

    it('while paused with a resume intent recorded: resume is disabled and shows the waiting line', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'paused', resumeRequestedAt: '2026-08-21T00:00:00.000Z' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('resume-button').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTestId('resume-requested')).toBeTruthy()
      expect(screen.getByTestId('resume-requested').textContent).toMatch(/resume requested/i)
    })

    it('while paused with no resume intent recorded: resume is enabled and the waiting line is absent', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'paused', resumeRequestedAt: null })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('resume-button').getAttribute('disabled')).toBeNull()
      expect(screen.queryByTestId('resume-requested')).toBeNull()
    })

    it('while paused and the workspace is halted: resume is disabled and shows the halt reason', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'paused' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason="the pause gate failed open"
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('resume-button').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByText(/the pause gate failed open/)).toBeTruthy()
    })

    it('while idle (no run): every control disabled, message box hidden entirely', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'idle', taskTitle: null, runId: null })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTestId('resume-button').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTestId('stop-button').getAttribute('disabled')).not.toBeNull()
      // Opened first, so this proves the box is ABSENT for an idle worker rather than merely folded.
      openGroup('messages')
      expect(screen.queryByTestId('message-box')).toBeNull()
    })
  })

  describe('current run block', () => {
    it('shows cost so far and tool calls', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'working', costUsd: 1.25, toolCalls: 7 })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      // M45 R4: the tool-call count leads the panel in the Run group; the money is its own group.
      expect(screen.getByTestId('run-tool-calls').textContent).toContain('7')
      openGroup('cost')
      expect(screen.getByTestId('run-cost').textContent).toContain('1.25')
    })

    it('shows the unknown mark, not $0.00, when the live run reports no cost', () => {
      // M12 Task 9 / ruling R3. `—` is the mark `AllSlavesTable`/`CompanyManager` already use for
      // unknown, so the surfaces agree on what "we do not know" looks like.
      render(
        <SlavePanel
          slave={slave({ status: 'working', costUsd: null, toolCalls: 7 })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('run-tool-calls').textContent).toContain('7')
      openGroup('cost')
      expect(screen.getByTestId('run-cost').textContent).toBe('—')
    })

    it('renders the run\'s own provider, and the unknown mark when no run has resolved one', () => {
      // M12 Task 9 / ruling R10. The bare kind for now: the human-readable label and the
      // shell-only gate mark are Task 13's, per spec §8.
      const { rerender } = render(
        <SlavePanel
          slave={slave({ provider: 'cursor', gate: 'shell-only' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('provider-chip').textContent).toBe('Cursor')
      expect(screen.getByTestId('provider-chip').getAttribute('title')).toBe('cursor')
      rerender(
        <SlavePanel
          slave={slave({ provider: null, gate: null })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('provider-chip').textContent).toBe('—')
    })

    // M44 final review, item I3: the panel read the bare `claude_code` column value as visible
    // text. The label is the word; the kind stays in `title`.
    it('reads the provider label, with the raw kind kept in title', () => {
      render(
        <SlavePanel
          slave={slave({ provider: 'claude_code', gate: 'all-tools' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('provider-chip').textContent).toBe('Claude Code')
      expect(screen.getByTestId('provider-chip').getAttribute('title')).toBe('claude_code')
    })

    // M12 Task 13 fix round 1, spec §8 / finding 4a: the shell-only gate mark, on the panel too.
    it('marks a shell-only gate, and shows no mark for an all-tools gate', () => {
      const { rerender } = render(
        <SlavePanel
          slave={slave({ provider: 'cursor', gate: 'shell-only' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByText(/shell only/i)).toBeTruthy()

      rerender(
        <SlavePanel
          slave={slave({ provider: 'claude_code', gate: 'all-tools' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.queryByText(/shell only/i)).toBeNull()
    })

    it('shows paused-at step when paused', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'paused', pausedAtStep: 4 })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('run-paused-step').textContent).toContain('4')
    })

    // M36 t2 fix round 1, finding 1.
    it('reads as waiting, not as an operator pause, when the run is waiting for another slave', () => {
      render(
        <SlavePanel
          slave={slave({
            status: 'paused',
            pausedAtStep: 4,
            waitingFor: { recipient: 'Maya', question: 'Which queue should retries land on?', messageId: 'm-1' },
          })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      // The human-pause detail gives way to what it is actually waiting on.
      expect(screen.queryByTestId('run-paused-step')).toBeNull()
      expect(screen.getByTestId('run-waiting-step').textContent).toContain('4')
      expect(screen.getByTestId('waiting-for').textContent).toContain('Maya')
      expect(screen.getByTestId('waiting-question').textContent).toContain('Which queue should retries land on?')
      // The control is still reachable -- typing an answer and sending it is what a human does
      // here -- but it is not labelled as resuming a pause somebody asked for, and it is no longer
      // the RESUME control at all (fix round 1, finding 1).
      expect(screen.queryByTestId('resume-button')).toBeNull()
      expect(screen.getByTestId('answer-button').textContent).toBe('answer')
      openGroup('messages')
      expect(screen.getByTestId('message-input')).toBeTruthy()
    })

    it('still reads as an operator pause when nothing is being waited on', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'paused', pausedAtStep: 4 })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('run-paused-step')).toBeTruthy()
      expect(screen.queryByTestId('waiting-for')).toBeNull()
      expect(screen.getByTestId('resume-button').textContent).toBe('resume')
    })

    it('does not show paused-at step outside paused, even if the field happens to be set', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'working', pausedAtStep: 4 })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.queryByTestId('run-paused-step')).toBeNull()
    })
  })

  // `OverviewClient` renders `<SlavePanel key={selectedSlave.id} ... />` — switching `?slave=`
  // unmounts the old instance rather than re-rendering it with new props. These tests render the
  // same way (`key` set explicitly, changed across `rerender`) so the remount semantics under
  // test are the ones production actually gets.
  describe('per-slave isolation (no state bleed across a keyed panel switch)', () => {
    it("clears slave A's error band once the panel switches to slave B", async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'workspace is halted' }), { status: 409 }),
      )
      const { rerender } = render(
        <SlavePanel key="a1" slave={slave({ id: 'a1', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('pause-button'))
      })
      expect(screen.getByRole('alert').textContent).toContain('workspace is halted')

      rerender(
        <SlavePanel key="a2" slave={slave({ id: 'a2', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      expect(screen.queryByRole('alert')).toBeNull()
    })

    it("does not carry slave A's in-flight pause-button disabled state onto slave B", () => {
      fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {})) // never resolves
      const { rerender } = render(
        <SlavePanel key="a1" slave={slave({ id: 'a1', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      fireEvent.click(screen.getByTestId('pause-button'))
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).not.toBeNull()

      rerender(
        <SlavePanel key="a2" slave={slave({ id: 'a2', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      expect(screen.getByTestId('pause-button').getAttribute('disabled')).toBeNull()
    })

    it("drops slave A's 409 that settles AFTER the switch to slave B — the late-arrival race", async () => {
      let resolveFetch!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          }),
      )
      const { rerender } = render(
        <SlavePanel key="a1" slave={slave({ id: 'a1', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      // A's pause POST is in flight, unresolved, when the panel switches to B — the exact
      // ordering the effect-based clear (fix round 1) could not close: nothing has settled yet,
      // so there is nothing for an on-switch effect to clear.
      fireEvent.click(screen.getByTestId('pause-button'))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      rerender(
        <SlavePanel key="a2" slave={slave({ id: 'a2', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).toBeNull()

      // A's request finally settles as a 409, after B is already on screen. A's continuation must
      // not paint onto B's (unmounted-A's setState is a no-op in React 18).
      await act(async () => {
        resolveFetch(new Response(JSON.stringify({ error: 'workspace is halted' }), { status: 409 }))
      })

      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).toBeNull()
    })
  })

  describe('controls', () => {
    it('clicking pause POSTs to the pause endpoint and disables the button while in flight', async () => {
      let resolveFetch!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          }),
      )
      render(
        <SlavePanel slave={slave({ status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      fireEvent.click(screen.getByTestId('pause-button'))

      expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/pause', expect.objectContaining({ method: 'POST' }))
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).not.toBeNull()

      await act(async () => {
        resolveFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      })
    })

    it("renders a 409 refusal's body in the panel's error band", async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'workspace is halted' }), { status: 409 }),
      )
      render(
        <SlavePanel slave={slave({ status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('pause-button'))
      })

      expect(screen.getByRole('alert').textContent).toContain('workspace is halted')
    })

    it('saving the message box POSTs to the message endpoint', async () => {
      render(
        <SlavePanel
          slave={slave({ status: 'paused', queuedMessage: 'first draft' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )

      openGroup('messages')
      const input = screen.getByTestId('message-input')
      expect((input as HTMLTextAreaElement).value).toBe('first draft')
      fireEvent.change(input, { target: { value: 'also update the README' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('message-save'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/runs/r1/message',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'also update the README' }),
        }),
      )
    })

    // M36 t3 fix round 1, finding 1: the answer button used to POST the run's `resume` route, which
    // wrote no message at all -- the asker resumed and the question stayed unanswered forever.
    it("answering a waiting slave POSTs the typed text to the QUESTION's answer endpoint", async () => {
      render(
        <SlavePanel
          slave={slave({
            status: 'paused',
            waitingFor: { recipient: 'Maya', question: 'Which queue?', messageId: 'm-1' },
          })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )

      openGroup('messages')
      fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'payments-retry' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('answer-button'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/messages/m-1/answer',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ answer: 'payments-retry' }) }),
      )
      // And never the resume route: resuming without writing the answer is the bug this replaced.
      expect(fetchMock).not.toHaveBeenCalledWith('/api/w/w1/runs/r1/resume', expect.anything())
    })

    it('refuses to send a blank answer before the round trip', () => {
      render(
        <SlavePanel
          slave={slave({
            status: 'paused',
            waitingFor: { recipient: 'Maya', question: 'Which queue?', messageId: 'm-1' },
          })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )

      expect(screen.getByTestId('answer-button').getAttribute('disabled')).not.toBeNull()
      openGroup('messages')
      fireEvent.change(screen.getByTestId('message-input'), { target: { value: 'payments-retry' } })
      expect(screen.getByTestId('answer-button').getAttribute('disabled')).toBeNull()
    })

    it('falls back to the plain resume when the question row is gone -- there is nothing to reply to', () => {
      render(
        <SlavePanel
          slave={slave({ status: 'paused', waitingFor: { recipient: 'another slave', question: null, messageId: null } })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )

      expect(screen.queryByTestId('answer-button')).toBeNull()
      expect(screen.getByTestId('resume-button')).toBeTruthy()
    })

    it('does not write state from the POST response beyond the error band (no optimistic UI)', async () => {
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      render(
        <SlavePanel slave={slave({ status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('pause-button'))
      })

      // Success renders no error and does not flip the slave's own status client-side — the
      // panel still shows the prop it was given ('working') until the refetch loop updates it.
      expect(screen.queryByRole('alert')).toBeNull()
      // M44 R5 leak 2: the header printed the raw `SlaveStatus`. It reads the projected word now
      // and keeps the raw value on the node, so this case still proves "the prop it was given".
      expect(screen.getByTestId('status-label').textContent).toBe('WORKING')
      expect(screen.getByTestId('status-label').getAttribute('title')).toBe('working')
      expect(screen.getByTestId('status-label').getAttribute('data-status')).toBe('working')
    })
  })

  describe('live feed', () => {
    it('merges the seed and live events by seq, deduplicated, newest at the bottom', () => {
      render(
        <SlavePanel
          slave={slave({
            recentEvents: [feedEvent({ seq: 1, summary: 'seed one' }), feedEvent({ seq: 2, summary: 'seed two' })],
          })}
          liveEvents={[feedEvent({ seq: 2, summary: 'live two (dup)' }), feedEvent({ seq: 3, summary: 'live three' })]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )

      openGroup('events')
      const rows = screen.getAllByTestId('feed-event').map((el) => el.textContent)
      expect(rows).toHaveLength(3)
      expect(rows[0]).toContain('seed one')
      expect(rows[1]).toContain('live two (dup)')
      expect(rows[2]).toContain('live three')
    })
  })

  it('calls onClose when the close control is used', () => {
    const onClose = vi.fn()
    render(<SlavePanel slave={slave({})} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  // Motion pass (spec §8 / M4 deferral). `OverviewClient` keys this panel by slave id, so every
  // mount (including a switch between slaves) is a fresh instance — the slide-in class replays
  // on every open by construction, no extra state needed here.
  it('carries the motion-safe panel slide-in animation class on its root', () => {
    const { container } = render(<SlavePanel slave={slave({})} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
    expect(container.querySelector('aside')?.className).toContain('motion-safe:animate-[panel-in_160ms_ease-out]')
  })
  // M37 t4. Spec §1: model output never writes a profile or a role set -- these two controls call
  // the control verbs through their routes, and nothing else in this panel writes either field.
  describe('profile and runtime roles (M37 §6)', () => {
    const render_ = (over: Partial<SlaveCardData>): void => {
      render(
        <SlavePanel slave={slave(over)} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )
    }

    it("shows the effective profile as TEXT in a textarea, with the level it came from", () => {
      render_({ profile: { text: '# Persona\n<b>careful</b> with payments', origin: 'company' } })

      openGroup('profile')
      const input = screen.getByTestId('profile-input') as HTMLTextAreaElement
      // Another party's text is data (spec §1): the markup arrives as characters in a form
      // control, never as elements.
      expect(input.value).toBe('# Persona\n<b>careful</b> with payments')
      expect(input.querySelector('b')).toBeNull()
      expect(screen.getByTestId('profile-origin').textContent).toMatch(/roster/i)
    })

    it("names the worker-level profile as the worker's own", () => {
      render_({ profile: { text: 'mine', origin: 'slave' } })

      openGroup('profile')
      expect(screen.getByTestId('profile-origin').textContent).toMatch(/own/i)
    })

    it('says when no level of the chain carries a profile, and leaves the box empty', () => {
      render_({ profile: null })

      openGroup('profile')
      expect(screen.getByTestId('profile-origin').textContent).toMatch(/no profile/i)
      expect((screen.getByTestId('profile-input') as HTMLTextAreaElement).value).toBe('')
    })

    it('saving the profile PATCHes the slave profile route with the typed text', async () => {
      render_({ profile: { text: 'inherited text', origin: 'template' } })

      openGroup('profile')
      fireEvent.change(screen.getByTestId('profile-input'), { target: { value: 'You are careful with payments.' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('profile-save'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/slaves/a1/profile',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ profile: 'You are careful with payments.' }) }),
      )
    })

    it('clearing the textarea and saving sends an explicit null — the override goes, the level below shows through', async () => {
      render_({ profile: { text: 'my override', origin: 'slave' } })

      openGroup('profile')
      fireEvent.change(screen.getByTestId('profile-input'), { target: { value: '   ' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('profile-save'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/slaves/a1/profile',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ profile: null }) }),
      )
    })

    it("renders a 409 refusal from the profile save in the panel's error band", async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'a profile may be at most 16000 characters; this one is 16001' }), { status: 409 }),
      )
      render_({ profile: null })

      openGroup('profile')
      fireEvent.change(screen.getByTestId('profile-input'), { target: { value: 'x' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('profile-save'))
      })

      expect(screen.getByRole('alert').textContent).toContain('at most 16000 characters')
    })

    it('renders one chip per runtime role', () => {
      render_({ runtimeRoles: ['backend', 'reviewer'] })

      // M45 R4: the roles live under Messages -- an empty set is what makes a worker unreachable
      // by a role-addressed message (spec §7), so the mailbox and its roles read as one thing.
      openGroup('messages')
      expect(screen.getAllByTestId('runtime-role-chip').map((chip) => chip.textContent)).toEqual(['backend', 'reviewer'])
      expect(screen.queryByTestId('not-dispatchable')).toBeNull()
    })

    it('warns that an empty set is parked: it can never be dispatched (spec §7)', () => {
      render_({ runtimeRoles: [] })

      openGroup('messages')
      expect(screen.queryByTestId('runtime-role-chip')).toBeNull()
      expect(screen.getByTestId('not-dispatchable').textContent).toMatch(/cannot be dispatched/i)
    })

    it('saving the roles PATCHes the replacement set, split on commas exactly as the CLI splits --roles', async () => {
      render_({ runtimeRoles: ['backend'] })

      openGroup('messages')
      fireEvent.change(screen.getByTestId('runtime-roles-input'), { target: { value: 'backend, reviewer' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('runtime-roles-save'))
      })

      // The pieces go over the wire untrimmed on purpose: `setRuntimeRoles`'s own `normaliseRoles`
      // trims entry by entry (the CLI's `--roles a, b` reaches it the same way), so the trim rule
      // lives in the verb rather than being restated -- differently -- in a component.
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/slaves/a1/runtime-roles',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ roles: ['backend', ' reviewer'] }) }),
      )
    })

    it('emptying the roles field parks the slave rather than sending one blank role', async () => {
      render_({ runtimeRoles: ['backend'] })

      openGroup('messages')
      fireEvent.change(screen.getByTestId('runtime-roles-input'), { target: { value: '  ' } })
      await act(async () => {
        fireEvent.click(screen.getByTestId('runtime-roles-save'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/slaves/a1/runtime-roles',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ roles: [] }) }),
      )
    })
  })

  // ===============================================================================================
  // M45 R4: progressive disclosure. The header keeps what a simple row shows; everything raw --
  // the provider kind, the profile's origin, the runtime-role members, the feed -- is under a group.
  // ===============================================================================================
  describe('progressive disclosure (M45 R4)', () => {
    it('groups the worker panel under the same Details names, in the spec order', () => {
      render(<SlavePanel slave={slave({})} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
      expect(screen.getAllByTestId('details-group').map((group) => group.getAttribute('data-group'))).toEqual([
        'run',
        'model',
        'profile',
        'skills',
        // M52 R7: the eighth group, between Skills (what a worker is FOR) and Messages -- two words
        // for two things, and the closed `advanced` group nested inside it renders nothing yet.
        'permissions',
        'messages',
        'cost',
        'events',
      ])
    })

    it('the header keeps the four things a simple row shows, ungrouped', () => {
      render(<SlavePanel slave={slave({})} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
      for (const id of ['status-dot', 'status-label', 'provider-chip', 'pause-button', 'resume-button', 'stop-button']) {
        expect(screen.getByTestId(id).closest('[data-testid="details-group"]')).toBeNull()
      }
    })

    it('leads with the Run group open and every other group closed', () => {
      render(<SlavePanel slave={slave({ status: 'working', toolCalls: 7 })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
      const open = screen
        .getAllByTestId('details-group')
        .filter((group) => group.getAttribute('data-open') === 'true')
        .map((group) => group.getAttribute('data-group'))
      expect(open).toEqual(['run'])
      expect(screen.getByTestId('run-tool-calls').textContent).toContain('7')
    })

    it('expands the provider chip under Model, with the raw kind and the raw gate kept in title', () => {
      render(
        <SlavePanel slave={slave({ provider: 'cursor', gate: 'shell-only' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )
      expect(screen.queryByTestId('model-provider')).toBeNull()
      openGroup('model')
      expect(screen.getByTestId('model-provider').textContent).toBe('Cursor')
      expect(screen.getByTestId('model-provider').getAttribute('title')).toBe('cursor')
      expect(screen.getByTestId('model-gate').getAttribute('title')).toBe('shell-only')
    })

    it('names the latest skill this run used under Skills, and points at the catalog', () => {
      render(
        <SlavePanel slave={slave({ skill: 'writing-plans' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )
      openGroup('skills')
      expect(screen.getByTestId('panel-skill').textContent).toBe('writing-plans')
      expect(screen.getByTestId('panel-skill-catalog').getAttribute('href')).toBe('/workforce?tab=skills')
    })

    it('shows the unknown mark under Skills when no Skill tool call has been seen on this run', () => {
      render(<SlavePanel slave={slave({ skill: null })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
      openGroup('skills')
      expect(screen.getByTestId('panel-skill').textContent).toBe('—')
    })

    it('keeps the runtime-role members inside a group, never as a bare word in the header', () => {
      render(
        <SlavePanel slave={slave({ runtimeRoles: ['backend', 'reviewer'] })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )
      expect(screen.queryByTestId('runtime-role-chip')).toBeNull()
      openGroup('messages')
      for (const chip of screen.getAllByTestId('runtime-role-chip')) {
        expect(chip.closest('[data-testid="details-group"]')?.getAttribute('data-group')).toBe('messages')
      }
    })

    it('keeps the cost figure in the Cost group and the live feed in the Events group', () => {
      render(
        <SlavePanel
          slave={slave({ costUsd: 1.25, recentEvents: [feedEvent({ seq: 1, summary: 'seed one' })] })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.queryByTestId('run-cost')).toBeNull()
      expect(screen.queryByTestId('feed-event')).toBeNull()
      openGroup('cost')
      expect(screen.getByTestId('run-cost').textContent).toContain('1.25')
      openGroup('events')
      expect(screen.getByTestId('feed-event').textContent).toContain('seed one')
    })
  })
})

/**
 * M52 R7: the eighth group, and the first that answers "what may this one DO".
 *
 * Every glyph and every sentence here is `grantsFor`'s answer, computed server-side by the same
 * function the gate's own `permissions.json` is built by -- so a case that asserts a ✓ is asserting
 * the hook would allow it, not that a component decided to draw one.
 */
describe('SlavePanel permissions (M52 R7)', () => {
  const governed = slave({
    permissions: [
      { kind: 'read_repo', mode: null, source: 'baseline', by: null, byName: null, at: null },
      { kind: 'write_repo', mode: null, source: 'baseline', by: null, byName: null, at: null },
      // `by` is a `User.id` -- that is what `setSlavePermission` writes (fix round 1, review
      // Important 1) -- and `byName` is what `buildOverviewSnapshot` resolved it to. The old
      // fixture stated `by: 'meren'`, a value production never holds, which is precisely why the
      // suite could not see the defect.
      { kind: 'run_commands', mode: 'deny', source: 'refused', by: 'u-9f3c', byName: 'meren', at: '2026-09-12T09:00:00.000Z' },
      { kind: 'network_fetch', mode: 'allow', source: 'granted', by: 'u-9f3c', byName: 'meren', at: '2026-09-12T10:00:00.000Z' },
      { kind: 'read_secret', mode: null, source: 'never', by: null, byName: null, at: null },
      { kind: 'deploy_release', mode: null, source: 'never', by: null, byName: null, at: null },
    ],
  })

  function openPermissions(): void {
    render(<SlavePanel slave={governed} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
    openGroup('permissions')
  }

  it('renders one line per operation, in the domain’s order, once the group is open', () => {
    openPermissions()
    const lines = screen.getAllByTestId(/^panel-permission-/u)
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual([...PERMISSION_KINDS])
  })

  it('prints the WORD and keeps the key on data-kind and in title (docs/ia.md rule 3)', () => {
    openPermissions()
    const line = screen.getByTestId('panel-permission-network_fetch')
    expect(line.textContent).toContain('Fetch over the network')
    expect(line.textContent).not.toContain('network_fetch')
    expect(line.getAttribute('title')).toBe('network_fetch')
    expect(line.getAttribute('data-kind')).toBe('network_fetch')
  })

  it('draws the three glyphs the matrix has always drawn, and a baseline reads as granted', () => {
    openPermissions()
    expect(screen.getByTestId('panel-permission-network_fetch').textContent).toContain('✓')
    expect(screen.getByTestId('panel-permission-run_commands').textContent).toContain('✕')
    expect(screen.getByTestId('panel-permission-read_secret').textContent).toContain('–')
    // A baseline is a ✓: the run really may do it, and a glyph that said otherwise would be the
    // surface disagreeing with the gate.
    expect(screen.getByTestId('panel-permission-read_repo').textContent).toContain('✓')
    expect(screen.getByTestId('panel-permission-read_repo').getAttribute('data-mode')).toBe('unset')
    expect(screen.getByTestId('panel-permission-read_repo').getAttribute('data-source')).toBe('baseline')
  })

  it('says WHO and WHEN under Advanced, and nothing at all until it is opened', () => {
    openPermissions()
    expect(screen.queryByTestId('panel-permission-source-network_fetch')).toBeNull()
    openGroup('advanced')
    expect(screen.getByTestId('panel-permission-source-network_fetch').textContent).toBe(
      'Granted by meren on 12 Sep 2026',
    )
    expect(screen.getByTestId('panel-permission-source-run_commands').textContent).toBe(
      'Refused by meren on 12 Sep 2026',
    )
    expect(screen.getByTestId('panel-permission-source-read_repo').textContent).toBe(
      'Baseline (implementation runs)',
    )
    expect(screen.getByTestId('panel-permission-source-read_secret').textContent).toContain('Never granted')
  })

  it('names the run kind the baseline was answered FOR, because a baseline is a fact about a run', () => {
    render(
      <SlavePanel
        slave={slave({
          permissionsRunKind: 'review',
          permissions: [
            { kind: 'read_repo', mode: null, source: 'baseline', by: null, byName: null, at: null },
            { kind: 'write_repo', mode: null, source: 'never', by: null, byName: null, at: null },
            { kind: 'run_commands', mode: null, source: 'baseline', by: null, byName: null, at: null },
            { kind: 'network_fetch', mode: null, source: 'never', by: null, byName: null, at: null },
            { kind: 'read_secret', mode: null, source: 'never', by: null, byName: null, at: null },
            { kind: 'deploy_release', mode: null, source: 'never', by: null, byName: null, at: null },
          ],
        })}
        liveEvents={[]}
        workspaceId="w1"
        haltedReason={null}
        onClose={() => {}}
      />,
    )
    openGroup('permissions')
    openGroup('advanced')
    expect(screen.getByTestId('panel-permission-source-read_repo').textContent).toBe('Baseline (review runs)')
  })

  it('says the two broker grants are not tools', () => {
    openPermissions()
    openGroup('advanced')
    expect(screen.getByTestId('panel-permission-source-deploy_release').textContent).toContain(
      'a brokered operation, not a tool',
    )
    expect(screen.getByTestId('panel-permission-source-read_secret').textContent).toContain(
      'a brokered operation, not a tool',
    )
    // …and the four that DO name tools say nothing of the sort.
    expect(screen.getByTestId('panel-permission-source-run_commands').textContent).not.toContain('brokered')
  })

  // Fix round 1, review Important 3: the glyph is `aria-hidden` (a `\u2713` read aloud is noise), so
  // without a word beside it all six lines had the SAME accessible name -- the operation, and
  // nothing about the answer. `PermissionMatrix` solves the identical problem on its cell with an
  // `aria-label`, in this same commit, and says so in a comment.
  it('says the answer to a screen reader, not only to an eye', () => {
    openPermissions()
    expect(screen.getByTestId('panel-permission-network_fetch').textContent).toContain('allowed')
    expect(screen.getByTestId('panel-permission-run_commands').textContent).toContain('refused')
    expect(screen.getByTestId('panel-permission-read_secret').textContent).toContain('not set')
    // A baseline is `allowed`: the glyph and the word must agree, or the two readings of this line
    // disagree about what the gate will do.
    expect(screen.getByTestId('panel-permission-read_repo').textContent).toContain('allowed')
    // …and the word is for a screen reader alone -- an eye reads the glyph.
    const word = screen.getByTestId('panel-permission-read_repo').querySelector('[data-testid="permission-mode-word"]')
    expect(word?.className).toContain('sr-only')
    // The testid deliberately does NOT start with `panel-permission-`: the first case in this
    // describe matches that prefix as a REGEX to count the lines, and a span inside each line
    // sharing the prefix would double every row it counts.
    expect(screen.getAllByTestId('permission-mode-word')).toHaveLength(6)
  })

  // Fix round 1, review Important 1. `SlavePermission.grantedBy` holds a `User.id`, so the sentence
  // read `Granted by 9f3c1b2e-… on 12 Sep 2026` in production while every fixture stated `meren`.
  // The NAME is resolved once per snapshot in `buildOverviewSnapshot`; the id stays in `title`.
  it('prints the granter’s NAME, and keeps the id one hover away', () => {
    openPermissions()
    openGroup('advanced')
    const line = screen.getByTestId('panel-permission-source-network_fetch')
    expect(line.textContent).toBe('Granted by meren on 12 Sep 2026')
    expect(line.textContent).not.toContain('u-9f3c')
    expect(line.getAttribute('title')).toBe('u-9f3c')
  })

  it('says a person is no longer on record rather than printing their id', () => {
    render(
      <SlavePanel
        slave={slave({
          permissions: [
            { kind: 'read_repo', mode: null, source: 'baseline', by: null, byName: null, at: null },
            { kind: 'write_repo', mode: null, source: 'baseline', by: null, byName: null, at: null },
            { kind: 'run_commands', mode: null, source: 'baseline', by: null, byName: null, at: null },
            // A row whose granter was deleted since: the id is real, the `User` row is gone.
            { kind: 'network_fetch', mode: 'allow', source: 'granted', by: 'u-gone', byName: null, at: '2026-09-12T10:00:00.000Z' },
            // A row written with no principal at all -- the CLI and the daemon have none.
            { kind: 'read_secret', mode: 'allow', source: 'granted', by: null, byName: null, at: '2026-09-12T10:00:00.000Z' },
            { kind: 'deploy_release', mode: null, source: 'never', by: null, byName: null, at: null },
          ],
        })}
        liveEvents={[]}
        workspaceId="w1"
        haltedReason={null}
        onClose={() => {}}
      />,
    )
    openGroup('permissions')
    openGroup('advanced')
    const deleted = screen.getByTestId('panel-permission-source-network_fetch')
    expect(deleted.textContent).toBe('Granted by a person no longer on record on 12 Sep 2026')
    expect(deleted.textContent).not.toContain('u-gone')
    expect(deleted.getAttribute('title')).toBe('u-gone')
    expect(screen.getByTestId('panel-permission-source-read_secret').textContent).toContain(
      'Granted by somebody unrecorded on 12 Sep 2026',
    )
  })

  it('never prints a granter or a date on the line itself -- a raw value lives under Advanced', () => {
    openPermissions()
    expect(screen.getByTestId('panel-permission-network_fetch').textContent).not.toContain('meren')
    expect(screen.getByTestId('panel-permission-network_fetch').textContent).not.toContain('2026')
  })

  it('sits between Skills and Messages, and arrives CLOSED like every group but Run', () => {
    render(<SlavePanel slave={governed} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
    const groups = screen.getAllByTestId('details-group').map((node) => node.getAttribute('data-group'))
    expect(groups.slice(groups.indexOf('skills'), groups.indexOf('messages') + 1)).toEqual([
      'skills',
      'permissions',
      'messages',
    ])
    const section = document.querySelector('[data-testid="details-group"][data-group="permissions"]')
    expect(section?.getAttribute('data-open')).toBe('false')
    expect(screen.queryByTestId('panel-permission-read_repo')).toBeNull()
  })
})
