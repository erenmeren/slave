// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPanel } from '../src/components/AgentPanel.js'
import type { AgentCardData, AgentFeedEvent } from '../src/server/overview.js'

const agent = (over: Partial<AgentCardData>): AgentCardData => ({
  id: 'a1',
  name: 'Alex',
  role: 'backend',
  provider: 'claude-code',
  status: 'working',
  taskTitle: 'Add the thing',
  actionLine: null,
  runId: 'r1',
  queuedMessage: null,
  recentEvents: [],
  costUsd: 0,
  toolCalls: 0,
  pausedAtStep: null,
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

  describe('per-agent isolation (no state bleed across a panel switch)', () => {
    it("clears agent A's error band once the panel switches to agent B", async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'workspace is halted' }), { status: 409 }),
      )
      const { rerender } = render(
        <AgentPanel agent={agent({ id: 'a1', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('pause-button'))
      })
      expect(screen.getByRole('alert').textContent).toContain('workspace is halted')

      rerender(
        <AgentPanel agent={agent({ id: 'a2', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      expect(screen.queryByRole('alert')).toBeNull()
    })

    it("does not carry agent A's in-flight pause-button disabled state onto agent B", () => {
      fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {})) // never resolves
      const { rerender } = render(
        <AgentPanel agent={agent({ id: 'a1', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

      fireEvent.click(screen.getByTestId('pause-button'))
      expect(screen.getByTestId('pause-button').getAttribute('disabled')).not.toBeNull()

      rerender(
        <AgentPanel agent={agent({ id: 'a2', status: 'working' })} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />,
      )

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
})
