'use client'

import { useState } from 'react'
import type { AgentStatus } from '@slave-of-ai/domain'
import { postControl } from '../../lib/postControl'
import { CARD_STATE_TONE, cardStateForAgent } from '../../lib/tones'
import type { GraphAgent } from '../../server/graph'
import { AvatarTile } from '../ui/AvatarTile'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { PanelHeader } from '../ui/PanelHeader'
import { ProgressBar } from '../ui/ProgressBar'
import { SECTION_LABEL_CLASS } from '../ui/SectionLabel'
import { StatusPill } from '../ui/StatusPill'

/** The handoff's quick-instruction chips (design README "1b — Drawer"). Fixed copy, and
 *  deliberately so: these are operator shorthand, not data — each one fills the free-text box,
 *  which is what actually sends. */
const QUICK_INSTRUCTIONS = ['rebase onto main first', 'add a test for this', 'stop after this step'] as const

/** `✓` done / `●` current / `○` pending (design README "1b — Drawer"). `server/graph.ts` decides
 *  which state each checkpoint is in; this table is only the glyph. */
const CHECKPOINT_GLYPH: Record<GraphAgent['checkpoints'][number]['state'], string> = {
  done: '✓',
  current: '●',
  pending: '○',
}

/** The `HH:MM:SS` slice of an ISO timestamp — the event tail shows a clock, not a date. */
function clockOf(iso: string): string {
  return iso.slice(11, 19)
}

/**
 * The 352px right drawer (design README §3a.4 / "1b — Drawer"): who the selected agent is, what
 * runtime it is on, what it is doing and how far through, its checkpoint list, the instruct box,
 * the three run controls, and the event tail.
 *
 * Every piece of anatomy comes from `ui/` (`AvatarTile`, `StatusPill`, `ProgressBar`,
 * `PanelHeader`, `Chip`) and every mutation goes through `lib/postControl.ts` at the SAME routes
 * `AgentPanel.tsx` already drives — Decision 2's "anatomy is written once", and no second control
 * vocabulary for the same three verbs.
 */
export function GraphDrawer({
  workspaceId,
  agent,
  onClose,
}: {
  readonly workspaceId: string
  readonly agent: GraphAgent
  readonly onClose: () => void
}): React.JSX.Element {
  const { tone, label, pulse } = CARD_STATE_TONE[cardStateForAgent(agent.status as AgentStatus)]
  const [draft, setDraft] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  const runId = agent.activeRunId

  const send = async (): Promise<void> => {
    if (runId === null || draft.trim() === '') return
    setErrorText(null)
    // The SAME route `AgentPanel`'s save button uses: the message is queued on the run and
    // consumed on its next resume. No second message vocabulary for the graph.
    const result = await postControl(`/api/w/${workspaceId}/runs/${runId}/message`, { message: draft })
    if (result.ok) setDraft('')
    else setErrorText(result.error)
  }

  const control = async (action: 'pause' | 'stop'): Promise<void> => {
    if (runId === null) return
    setErrorText(null)
    const result = await postControl(`/api/w/${workspaceId}/runs/${runId}/${action}`)
    if (!result.ok) setErrorText(result.error)
  }

  return (
    <aside
      data-testid="graph-drawer"
      aria-label="Agent detail"
      className="flex w-[352px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-4"
    >
      <header className="flex items-start gap-[9px]">
        <AvatarTile name={agent.name} tone={tone} />
        <div className="min-w-0 flex-1">
          <div data-testid="drawer-name" className="truncate text-[13px] font-semibold text-text-1">
            {agent.name}
          </div>
          <div className="truncate text-[10.5px] text-text-2">{agent.role}</div>
        </div>
        <StatusPill tone={tone} label={label} pulse={pulse} />
        <Button variant="ghost" data-testid="drawer-close" onClick={onClose} aria-label="Close agent detail" className="px-2 py-1">
          ✕
        </Button>
      </header>

      {/* The two runtime tiles. `gap-px` over a `bg-line` grid is the handoff's hairline-between-
        * cells recipe — one shared border rather than two abutting ones. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-tile border border-line bg-line">
        <div className="bg-bg-2 p-[10px]">
          <div className={SECTION_LABEL_CLASS}>provider</div>
          <div data-testid="drawer-provider" className="truncate font-mono text-[11px] text-text-1">
            {agent.provider ?? '—'}
          </div>
        </div>
        <div className="bg-bg-2 p-[10px]">
          <div className={SECTION_LABEL_CLASS}>model</div>
          <div data-testid="drawer-model" className="truncate font-mono text-[11px] text-text-1">
            {agent.model ?? '—'}
          </div>
        </div>
      </div>

      <section className="flex flex-col gap-1.5">
        <PanelHeader title="current task" />
        <p data-testid="drawer-task" className="truncate text-[11.5px] text-text-1">
          {agent.activeTaskTitle ?? 'no task'}
        </p>
        <ProgressBar pct={agent.progressPct} tone={tone} size="card" />
      </section>

      <section className="flex flex-col gap-1.5">
        <PanelHeader title="checkpoints" />
        {agent.checkpoints.length === 0 ? (
          <p className="text-[11px] text-text-3">none yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {agent.checkpoints.map((checkpoint) => (
              <li
                key={checkpoint.label}
                data-testid="drawer-checkpoint"
                data-state={checkpoint.state}
                className="flex items-baseline gap-2 text-[11px] text-text-2"
              >
                <span aria-hidden className="font-mono text-text-3">
                  {CHECKPOINT_GLYPH[checkpoint.state]}
                </span>
                <span className="min-w-0 truncate">{checkpoint.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <PanelHeader title="instruct" />
        <div className="flex flex-wrap gap-1">
          {QUICK_INSTRUCTIONS.map((instruction) => (
            <button
              key={instruction}
              type="button"
              data-testid="drawer-quick"
              onClick={() => setDraft(instruction)}
              className="rounded-chip transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={runId === null}
            >
              <Chip>{instruction}</Chip>
            </button>
          ))}
        </div>
        <input
          data-testid="drawer-instruct"
          aria-label="instruct the agent"
          value={draft}
          disabled={runId === null}
          placeholder={runId === null ? 'no live run' : 'type an instruction, Enter to send'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends (design README "1b — Drawer").
            if (event.key === 'Enter') void send()
          }}
          className="rounded-tile border border-line bg-bg-0 px-2 py-1 text-xs text-text-1 placeholder:text-text-3 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </section>

      <section className="flex flex-wrap gap-2">
        <Button variant="ghost" data-testid="drawer-pause" disabled={runId === null} onClick={() => void control('pause')}>
          Pause
        </Button>
        {/* Honestly disabled: there is no reassign verb in `packages/control`, and a button that
          * does nothing is worse than one that says it cannot yet. */}
        <Button variant="ghost" data-testid="drawer-reassign" disabled title="arrives in a later milestone">
          Reassign · later
        </Button>
        <Button variant="ghost" data-testid="drawer-stop" disabled={runId === null} onClick={() => void control('stop')}>
          Stop
        </Button>
      </section>

      {errorText !== null && (
        <span role="alert" data-testid="drawer-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}

      <section className="flex flex-col gap-1.5">
        <PanelHeader title="recent events" />
        {agent.recentEvents.length === 0 ? (
          <p className="text-[11px] text-text-3">nothing yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {agent.recentEvents.map((event) => (
              <li key={event.seq} data-testid="drawer-event" className="flex items-baseline gap-2 font-mono text-[10px] text-text-2">
                <span className="shrink-0 text-text-3">{clockOf(event.ts)}</span>
                <span className="min-w-0 truncate">{event.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
