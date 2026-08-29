// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPanel } from '../src/components/AgentPanel.js'
import type { AgentCardData, AgentFeedEvent } from '../src/server/overview.js'

const agent = (over: Partial<AgentCardData>): AgentCardData => ({
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
  actionLine: null,
  runId: 'r1',
  queuedMessage: null,
  resumeRequestedAt: null,
  recentEvents: [],
  costUsd: 0,
  toolCalls: 0,
  pausedAtStep: null,
  sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ...over,
})

const feedEvent = (over: Partial<AgentFeedEvent>): AgentFeedEvent => ({
  seq: 1,
  ts: new Date(0).toISOString(),
  type: 'run.tool_call',
  summary: 'Write note.txt',
  ...over,
})

describe('AgentPanel', () => {
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
          <AgentPanel
            agent={agent({ status })}
            liveEvents={[]}
            workspaceId="w1"
            haltedReason={null}
            onClose={() => {}}
          />,
        )
        expect(screen.getByTestId('pause-button').getAttribute('disabled')).toBeNull()
        expect(screen.getByTestId('resume-button').getAttribute('disabled')).not.toBeNull()
        expect(screen.getByTestId('stop-button').getAttribute('disabled')).toBeNull()
        expect(screen.getByTestId('message-hint')).toBeTruthy()
        expect(screen.queryByTestId('message-input')).toBeNull()
      },
    )

    it('while paused (workspace not halted): pause disabled, resume enabled, stop enabled, message box writable', () => {
      render(
        <AgentPanel
          agent={agent({ status: 'paused', queuedMessage: 'do the thing' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTestId('resume-button').getAttribute('disabled')).toBeNull()
      expect(screen.getByTestId('stop-button').getAttribute('disabled')).toBeNull()
      expect(screen.getByTestId('message-input')).toBeTruthy()
      expect(screen.queryByTestId('message-hint')).toBeNull()
    })

    it('while paused with a resume intent recorded: resume is disabled and shows the waiting line', () => {
      render(
        <AgentPanel
          agent={agent({ status: 'paused', resumeRequestedAt: '2026-08-21T00:00:00.000Z' })}
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
        <AgentPanel
          agent={agent({ status: 'paused', resumeRequestedAt: null })}
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
        <AgentPanel
          agent={agent({ status: 'paused' })}
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
        <AgentPanel
          agent={agent({ status: 'idle', taskTitle: null, runId: null })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTestId('resume-button').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTestId('stop-button').getAttribute('disabled')).not.toBeNull()
      expect(screen.queryByTestId('message-box')).toBeNull()
    })
  })

  describe('current run block', () => {
    it('shows cost so far and tool calls', () => {
      render(
        <AgentPanel
          agent={agent({ status: 'working', costUsd: 1.25, toolCalls: 7 })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('run-cost').textContent).toContain('1.25')
      expect(screen.getByTestId('run-tool-calls').textContent).toContain('7')
    })

    it('shows the unknown mark, not $0.00, when the live run reports no cost', () => {
      // M12 Task 9 / ruling R3. `—` is the mark `RosterTable`/`CompanyManager` already use for
      // unknown, so the surfaces agree on what "we do not know" looks like.
      render(
        <AgentPanel
          agent={agent({ status: 'working', costUsd: null, toolCalls: 7 })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('run-cost').textContent).toBe('—')
      expect(screen.getByTestId('run-tool-calls').textContent).toContain('7')
    })

    it('renders the run\'s own provider, and the unknown mark when no run has resolved one', () => {
      // M12 Task 9 / ruling R10. The bare kind for now: the human-readable label and the
      // shell-only gate mark are Task 13's, per spec §8.
      const { rerender } = render(
        <AgentPanel
          agent={agent({ provider: 'cursor', gate: 'shell-only' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('provider-chip').textContent).toBe('cursor')
      rerender(
        <AgentPanel
          agent={agent({ provider: null, gate: null })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('provider-chip').textContent).toBe('—')
    })

    // M12 Task 13 fix round 1, spec §8 / finding 4a: the shell-only gate mark, on the panel too.
    it('marks a shell-only gate, and shows no mark for an all-tools gate', () => {
      const { rerender } = render(
        <AgentPanel
          agent={agent({ provider: 'cursor', gate: 'shell-only' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByText(/shell only/i)).toBeTruthy()

      rerender(
        <AgentPanel
          agent={agent({ provider: 'claude_code', gate: 'all-tools' })}
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
        <AgentPanel
          agent={agent({ status: 'paused', pausedAtStep: 4 })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId('run-paused-step').textContent).toContain('4')
    })

    it('does not show paused-at step outside paused, even if the field happens to be set', () => {
      render(
        <AgentPanel
          agent={agent({ status: 'working', pausedAtStep: 4 })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )
      expect(screen.queryByTestId('run-paused-step')).toBeNull()
    })
  })

  // `OverviewClient` renders `<AgentPanel key={selectedAgent.id} ... />` — switching `?agent=`
  // unmounts the old instance rather than re-rendering it with new props. These tests render the
  // same way (`key` set explicitly, changed across `rerender`) so the remount semantics under
  // test are the ones production actually gets.
  describe('per-agent isolation (no state bleed across a keyed panel switch)', () => {
    it("clears agent A's error band once the panel switches to agent B", async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'workspace is halted' }), { status: 409 }),
      )
      const { rerender } = render(
        <AgentPanel key="a1" agent={agent({ id: 'a1', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('pause-button'))
      })
      expect(screen.getByRole('alert').textContent).toContain('workspace is halted')

      rerender(
        <AgentPanel key="a2" agent={agent({ id: 'a2', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      expect(screen.queryByRole('alert')).toBeNull()
    })

    it("does not carry agent A's in-flight pause-button disabled state onto agent B", () => {
      fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {})) // never resolves
      const { rerender } = render(
        <AgentPanel key="a1" agent={agent({ id: 'a1', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      fireEvent.click(screen.getByTestId('pause-button'))
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).not.toBeNull()

      rerender(
        <AgentPanel key="a2" agent={agent({ id: 'a2', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      expect(screen.getByTestId('pause-button').getAttribute('disabled')).toBeNull()
    })

    it("drops agent A's 409 that settles AFTER the switch to agent B — the late-arrival race", async () => {
      let resolveFetch!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          }),
      )
      const { rerender } = render(
        <AgentPanel key="a1" agent={agent({ id: 'a1', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      // A's pause POST is in flight, unresolved, when the panel switches to B — the exact
      // ordering the effect-based clear (fix round 1) could not close: nothing has settled yet,
      // so there is nothing for an on-switch effect to clear.
      fireEvent.click(screen.getByTestId('pause-button'))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      rerender(
        <AgentPanel key="a2" agent={agent({ id: 'a2', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
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
        <AgentPanel agent={agent({ status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
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
        <AgentPanel agent={agent({ status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('pause-button'))
      })

      expect(screen.getByRole('alert').textContent).toContain('workspace is halted')
    })

    it('saving the message box POSTs to the message endpoint', async () => {
      render(
        <AgentPanel
          agent={agent({ status: 'paused', queuedMessage: 'first draft' })}
          liveEvents={[]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )

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

    it('does not write state from the POST response beyond the error band (no optimistic UI)', async () => {
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      render(
        <AgentPanel agent={agent({ status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('pause-button'))
      })

      // Success renders no error and does not flip the agent's own status client-side — the
      // panel still shows the prop it was given ('working') until the refetch loop updates it.
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByTestId('status-label').textContent).toBe('working')
    })
  })

  describe('live feed', () => {
    it('merges the seed and live events by seq, deduplicated, newest at the bottom', () => {
      render(
        <AgentPanel
          agent={agent({
            recentEvents: [feedEvent({ seq: 1, summary: 'seed one' }), feedEvent({ seq: 2, summary: 'seed two' })],
          })}
          liveEvents={[feedEvent({ seq: 2, summary: 'live two (dup)' }), feedEvent({ seq: 3, summary: 'live three' })]}
          workspaceId="w1"
          haltedReason={null}
          onClose={() => {}}
        />,
      )

      const rows = screen.getAllByTestId('feed-event').map((el) => el.textContent)
      expect(rows).toHaveLength(3)
      expect(rows[0]).toContain('seed one')
      expect(rows[1]).toContain('live two (dup)')
      expect(rows[2]).toContain('live three')
    })
  })

  it('calls onClose when the close control is used', () => {
    const onClose = vi.fn()
    render(<AgentPanel agent={agent({})} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  // Motion pass (spec §8 / M4 deferral). `OverviewClient` keys this panel by agent id, so every
  // mount (including a switch between agents) is a fresh instance — the slide-in class replays
  // on every open by construction, no extra state needed here.
  it('carries the motion-safe panel slide-in animation class on its root', () => {
    const { container } = render(<AgentPanel agent={agent({})} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
    expect(container.querySelector('aside')?.className).toContain('motion-safe:animate-[panel-in_160ms_ease-out]')
  })
})
