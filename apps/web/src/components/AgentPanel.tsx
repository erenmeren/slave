'use client'

import { useEffect, useMemo, useState } from 'react'
import type { AgentFeedEvent } from '../lib/feedSummary'
import type { AgentCardData } from '../server/overview'
import { DOT } from './AgentCard'
import { ShellOnlyMark } from './ShellOnlyMark'
import { Button } from './ui/Button'
import { Chip } from './ui/Chip'

type ControlAction = 'pause' | 'resume' | 'stop' | 'message'

/** Pulls a 409 refusal's `{ error }` text, falling back to something nameable for any other
 *  non-2xx or malformed body — the panel's error band must never render blank (spec §9). */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

/** Bare `fetch(url, { method: 'POST', ... })` — the constraint every control POST here follows.
 *  No state is written from the response beyond the error band; the event-driven refetch loop
 *  (`useOverview`) owns truth. */
async function postControl(url: string, body?: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response =
      body === undefined
        ? await fetch(url, { method: 'POST' })
        : await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (response.ok) return { ok: true }
    const data: unknown = await response.json().catch(() => null)
    return { ok: false, error: errorMessage(data, response.status) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Seed (`agent.recentEvents`, last 20 from the DB) merged with the live buffer
 *  (`liveEvents[agent.id]`), deduplicated by seq, ascending — newest at the bottom. */
function mergeFeed(seed: readonly AgentFeedEvent[], live: readonly AgentFeedEvent[]): readonly AgentFeedEvent[] {
  const bySeq = new Map<number, AgentFeedEvent>()
  for (const event of seed) bySeq.set(event.seq, event)
  for (const event of live) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function AgentPanel({
  agent,
  liveEvents,
  workspaceId,
  haltedReason,
  onClose,
}: {
  readonly agent: AgentCardData
  readonly liveEvents: readonly AgentFeedEvent[]
  readonly workspaceId: string
  /** The workspace's current halt reason, if any — drives the "resume disabled + halt reason"
   *  cell of the enable/disable matrix (spec §6). */
  readonly haltedReason: string | null
  readonly onClose: () => void
}): React.JSX.Element {
  const [pending, setPending] = useState<ReadonlySet<ControlAction>>(new Set())
  const [errorText, setErrorText] = useState<string | null>(null)
  const [draft, setDraft] = useState(agent.queuedMessage ?? '')

  // Resync the draft from the snapshot's queued message whenever it changes for this agent — a
  // resume consuming it, or another client overwriting it. Not optimistic UI: this reads what the
  // snapshot already carried in, it never reads a POST's response body. `agent.id` no longer
  // needs to be a dependency: `OverviewClient` keys the `<AgentPanel>` element on the agent id
  // (fix round 2, Finding 2), so switching agents unmounts this instance rather than re-rendering
  // it with a new `agent` prop — every render of a given instance is the same agent throughout
  // its lifetime, by construction.
  useEffect((): void => {
    setDraft(agent.queuedMessage ?? '')
  }, [agent.queuedMessage])

  const runId = agent.runId
  const status = agent.status
  const pauseEnabled = runId !== null && (status === 'starting' || status === 'working' || status === 'resuming')
  const stopEnabled = runId !== null && status !== 'idle'
  const workspaceHalted = haltedReason !== null
  // While a recorded intent is still waiting for the daemon/CLI to claim it, another click would
  // just record a second intent on top of the first (`requestResume` has no idempotency beyond
  // the single `resumeRequestedAt` column) — disabled here keeps that double-click a no-op.
  const resumeRequestedWhilePaused = status === 'paused' && agent.resumeRequestedAt !== null
  const resumeEnabled = runId !== null && status === 'paused' && !workspaceHalted && !resumeRequestedWhilePaused
  const showMessageBox = status !== 'idle'
  const messageWritable = status === 'paused'

  const feed = useMemo(() => mergeFeed(agent.recentEvents, liveEvents), [agent.recentEvents, liveEvents])

  const run = async (action: ControlAction, path: string, body?: Record<string, unknown>): Promise<void> => {
    if (runId === null) return
    setPending((current) => new Set(current).add(action))
    setErrorText(null)
    const result = await postControl(`/api/w/${workspaceId}/runs/${runId}/${path}`, body)
    if (!result.ok) setErrorText(result.error)
    setPending((current) => {
      const next = new Set(current)
      next.delete(action)
      return next
    })
  }

  return (
    <aside
      aria-label="Agent detail"
      // Slide-in (spec §8): this panel is mounted fresh per agent (`OverviewClient` keys it by
      // agent id), so the animation replays on every open/switch by construction.
      className="fixed inset-y-0 right-0 z-10 flex w-96 flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-4 motion-safe:animate-[panel-in_160ms_ease-out]"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            data-testid="status-dot"
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[agent.status]} ${agent.status === 'working' ? 'animate-pulse' : ''}`}
          />
          <div>
            <h2 className="text-sm font-medium text-text-1">{agent.name}</h2>
            <span className="text-xs text-text-3">{agent.role}</span>
          </div>
          <span data-testid="status-label" className="ml-1 text-xs text-text-2">
            {agent.status}
          </span>
          {/* The bare kind here, `—` when no run has resolved one (M12 Task 9, ruling R10).
            *  The shell-only gate mark (spec §8) is `ShellOnlyMark` (M12 Task 13 fix round 1,
            *  finding 4a) -- a human-readable provider LABEL is still nobody's brief. */}
          <Chip>
            <span data-testid="provider-chip">{agent.provider ?? '—'}</span>
          </Chip>
          <ShellOnlyMark gate={agent.gate} />
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close agent detail">
          close
        </Button>
      </header>

      <div className="text-sm text-text-1">{agent.taskTitle ?? <span className="text-text-3">idle</span>}</div>

      <div className="flex items-center gap-3 font-mono text-xs text-text-2">
        {/* `—`, the mark the Roster already uses for unknown -- never `$0.00`, which claims a
          *  measurement this run never made (spec Decision 6; M12 Task 9, ruling R3). */}
        <span data-testid="run-cost">{agent.costUsd === null ? '—' : `$${agent.costUsd.toFixed(2)}`}</span>
        <span data-testid="run-tool-calls">{agent.toolCalls} calls</span>
        {status === 'paused' && agent.pausedAtStep !== null && (
          <span data-testid="run-paused-step">paused at step {agent.pausedAtStep}</span>
        )}
      </div>

      {errorText !== null && (
        <div role="alert" data-testid="panel-error" className="rounded border border-status-danger/40 bg-status-danger/10 px-2 py-1.5 text-xs text-status-danger">
          {errorText}
        </div>
      )}

      <section className="flex gap-2">
        <Button variant="ghost" data-testid="pause-button" disabled={!pauseEnabled || pending.has('pause')} onClick={() => void run('pause', 'pause')}>
          pause
        </Button>
        <Button variant="ghost" data-testid="resume-button" disabled={!resumeEnabled || pending.has('resume')} onClick={() => void run('resume', 'resume')}>
          resume
        </Button>
        <Button variant="ghost" data-testid="stop-button" disabled={!stopEnabled || pending.has('stop')} onClick={() => void run('stop', 'stop')}>
          stop
        </Button>
      </section>

      {resumeRequestedWhilePaused && (
        <p data-testid="resume-requested" className="text-xs text-text-3">
          resume requested — waiting for the daemon
        </p>
      )}

      {status === 'paused' && workspaceHalted && (
        <p data-testid="resume-halt-reason" className="text-xs text-status-danger">
          workspace halted: {haltedReason}
        </p>
      )}

      {showMessageBox && (
        <section data-testid="message-box" className="flex flex-col gap-1">
          <h3 className="text-xs uppercase tracking-wide text-text-3">Message</h3>
          {messageWritable ? (
            <>
              <textarea
                data-testid="message-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
                rows={3}
              />
              <Button
                variant="ghost"
                data-testid="message-save"
                disabled={pending.has('message')}
                onClick={() => void run('message', 'message', { message: draft })}
                className="self-end"
              >
                save
              </Button>
            </>
          ) : (
            <p data-testid="message-hint" className="text-xs text-text-3">
              pause to send an instruction
            </p>
          )}
        </section>
      )}

      <section className="flex flex-1 flex-col gap-1 overflow-y-auto">
        <h3 className="text-xs uppercase tracking-wide text-text-3">Live feed</h3>
        {feed.length === 0 ? (
          <p className="text-xs text-text-3">no events yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {feed.map((event) => (
              <li key={event.seq} data-testid="feed-event" className="font-mono text-xs text-text-2">
                {event.summary}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
