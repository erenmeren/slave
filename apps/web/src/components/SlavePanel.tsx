'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SlaveFeedEvent } from '../lib/feedSummary'
import type { SlaveCardData } from '../server/overview'
import { postControl } from '../lib/postControl'
import { DOT } from './SlaveCard'
import { ShellOnlyMark } from './ShellOnlyMark'
import { Button } from './ui/Button'
import { Chip } from './ui/Chip'

type ControlAction = 'pause' | 'resume' | 'stop' | 'message'

/** Seed (`slave.recentEvents`, last 20 from the DB) merged with the live buffer
 *  (`liveEvents[slave.id]`), deduplicated by seq, ascending — newest at the bottom. */
function mergeFeed(seed: readonly SlaveFeedEvent[], live: readonly SlaveFeedEvent[]): readonly SlaveFeedEvent[] {
  const bySeq = new Map<number, SlaveFeedEvent>()
  for (const event of seed) bySeq.set(event.seq, event)
  for (const event of live) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function SlavePanel({
  slave,
  liveEvents,
  workspaceId,
  haltedReason,
  onClose,
}: {
  readonly slave: SlaveCardData
  readonly liveEvents: readonly SlaveFeedEvent[]
  readonly workspaceId: string
  /** The workspace's current halt reason, if any — drives the "resume disabled + halt reason"
   *  cell of the enable/disable matrix (spec §6). */
  readonly haltedReason: string | null
  readonly onClose: () => void
}): React.JSX.Element {
  const [pending, setPending] = useState<ReadonlySet<ControlAction>>(new Set())
  const [errorText, setErrorText] = useState<string | null>(null)
  const [draft, setDraft] = useState(slave.queuedMessage ?? '')

  // Resync the draft from the snapshot's queued message whenever it changes for this slave — a
  // resume consuming it, or another client overwriting it. Not optimistic UI: this reads what the
  // snapshot already carried in, it never reads a POST's response body. `slave.id` no longer
  // needs to be a dependency: `OverviewClient` keys the `<SlavePanel>` element on the slave id
  // (fix round 2, Finding 2), so switching slaves unmounts this instance rather than re-rendering
  // it with a new `slave` prop — every render of a given instance is the same slave throughout
  // its lifetime, by construction.
  useEffect((): void => {
    setDraft(slave.queuedMessage ?? '')
  }, [slave.queuedMessage])

  const runId = slave.runId
  const status = slave.status
  const pauseEnabled = runId !== null && (status === 'starting' || status === 'working' || status === 'resuming')
  const stopEnabled = runId !== null && status !== 'idle'
  const workspaceHalted = haltedReason !== null
  // While a recorded intent is still waiting for the daemon/CLI to claim it, another click would
  // just record a second intent on top of the first (`requestResume` has no idempotency beyond
  // the single `resumeRequestedAt` column) — disabled here keeps that double-click a no-op.
  const resumeRequestedWhilePaused = status === 'paused' && slave.resumeRequestedAt !== null
  const resumeEnabled = runId !== null && status === 'paused' && !workspaceHalted && !resumeRequestedWhilePaused
  const showMessageBox = status !== 'idle'
  const messageWritable = status === 'paused'

  const feed = useMemo(() => mergeFeed(slave.recentEvents, liveEvents), [slave.recentEvents, liveEvents])

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
      aria-label="Slave detail"
      // Slide-in (spec §8): this panel is mounted fresh per slave (`OverviewClient` keys it by
      // slave id), so the animation replays on every open/switch by construction.
      className="fixed inset-y-0 right-0 z-10 flex w-96 flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-4 motion-safe:animate-[panel-in_160ms_ease-out]"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            data-testid="status-dot"
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[slave.status]} ${slave.status === 'working' ? 'animate-pulse' : ''}`}
          />
          <div>
            <h2 className="text-sm font-medium text-text-1">{slave.name}</h2>
            <span className="text-xs text-text-3">{slave.role}</span>
          </div>
          <span data-testid="status-label" className="ml-1 text-xs text-text-2">
            {slave.status}
          </span>
          {/* The bare kind here, `—` when no run has resolved one (M12 Task 9, ruling R10).
            *  The shell-only gate mark (spec §8) is `ShellOnlyMark` (M12 Task 13 fix round 1,
            *  finding 4a) -- a human-readable provider LABEL is still nobody's brief. */}
          <Chip>
            <span data-testid="provider-chip">{slave.provider ?? '—'}</span>
          </Chip>
          <ShellOnlyMark gate={slave.gate} />
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close slave detail">
          close
        </Button>
      </header>

      <div className="text-sm text-text-1">{slave.taskTitle ?? <span className="text-text-3">idle</span>}</div>

      <div className="flex items-center gap-3 font-mono text-xs text-text-2">
        {/* `—`, the mark the Roster already uses for unknown -- never `$0.00`, which claims a
          *  measurement this run never made (spec Decision 6; M12 Task 9, ruling R3). */}
        <span data-testid="run-cost">{slave.costUsd === null ? '—' : `$${slave.costUsd.toFixed(2)}`}</span>
        <span data-testid="run-tool-calls">{slave.toolCalls} calls</span>
        {status === 'paused' && slave.pausedAtStep !== null && (
          <span data-testid="run-paused-step">paused at step {slave.pausedAtStep}</span>
        )}
      </div>

      {errorText !== null && (
        <div role="alert" data-testid="panel-error" className="rounded border border-tone-blocked/40 bg-tone-blocked/10 px-2 py-1.5 text-xs text-tone-blocked">
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
        <p data-testid="resume-halt-reason" className="text-xs text-tone-blocked">
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
