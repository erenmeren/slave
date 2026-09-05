'use client'

import { useState } from 'react'
import type { LiveStatus } from '../../lib/office/liveOffice'

export interface FocusView {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly department: string
  readonly color: string
  readonly status: LiveStatus
  readonly statusColor: string
  readonly taskKey: string
  readonly taskTitle: string
  readonly pct: number
  readonly runId: string | null
}

/** The design's focus card (M28 §5–§6): who, what, how far, and the run's Pause/Resume/Stop. The
 *  buttons call back with the action; the caller talks to the run routes and returns the refusal
 *  text (or null), which stays on the card until the next action. */
export function FocusCard({
  view,
  archived,
  onRun,
  onNext,
}: {
  readonly view: FocusView
  readonly archived: boolean
  readonly onRun: (runId: string, action: 'pause' | 'resume' | 'stop') => Promise<string | null>
  readonly onNext: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // R16: Resume is offered only while the run is actually `paused` (spec §5). While `pausing` the
  // pause has been asked for but not taken effect — the button keeps saying Pause and goes
  // disabled, so the card never invites a resume of a run that is still stopping work.
  const paused = view.status === 'paused'
  const runAction = async (action: 'pause' | 'resume' | 'stop'): Promise<void> => {
    if (view.runId === null) return
    setPending(true)
    setError(await onRun(view.runId, action))
    setPending(false)
  }
  const button = 'flex-1 rounded-[5px] border border-[rgba(255,255,255,.12)] bg-transparent py-1 text-[10.5px] font-medium text-[#c8cfda] disabled:opacity-40'
  return (
    <div
      data-testid="office-focus"
      className="absolute right-3 top-3 flex w-[min(236px,calc(100%-24px))] flex-col gap-[6px] rounded-lg border border-[rgba(255,255,255,.1)] bg-[rgba(10,12,16,.86)] px-3 py-[10px] backdrop-blur-[6px]"
    >
      <div className="flex items-center gap-2">
        <div
          className="grid h-[26px] w-[26px] flex-none place-items-center rounded-md border font-mono text-[10px] font-semibold"
          style={{ background: `${view.color}1a`, borderColor: `${view.color}3d`, color: view.color }}
        >
          {view.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold">{view.name}</div>
          <div className="truncate text-[10px] text-[#7c8697]">
            {view.role} · {view.department}
          </div>
        </div>
        <span className="ml-auto whitespace-nowrap font-mono text-[9.5px] font-medium" style={{ color: view.statusColor }}>
          ● {view.status}
        </span>
      </div>
      <div className="truncate text-[11px] text-[#c8cfda]">
        <span className="font-mono text-[10px] text-[#5b6472]">{view.taskKey}</span> {view.taskTitle}
      </div>
      <div className="h-[3px] rounded-sm bg-[rgba(255,255,255,.06)]">
        <div className="h-full rounded-sm transition-[width] duration-500" style={{ width: `${view.pct}%`, background: view.statusColor, boxShadow: `0 0 8px ${view.statusColor}` }} />
      </div>
      <div className="flex gap-[5px]">
        {!archived && (
          <button type="button" data-testid="office-focus-pause" disabled={pending || view.runId === null || view.status === 'pausing'} onClick={() => void runAction(paused ? 'resume' : 'pause')} className={button}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        )}
        <button type="button" data-testid="office-focus-next" onClick={onNext} className={button}>
          Next ⇄
        </button>
        {!archived && (
          <button
            type="button"
            data-testid="office-focus-stop"
            disabled={pending || view.runId === null}
            onClick={() => void runAction('stop')}
            className="rounded-[5px] border border-[#f871713d] bg-transparent px-[9px] py-1 text-[10.5px] font-medium text-[#f87171] disabled:opacity-40"
          >
            Stop
          </button>
        )}
      </div>
      {error !== null && (
        <span role="alert" data-testid="office-focus-error" className="text-[10px] text-[#f87171]">
          {error}
        </span>
      )}
    </div>
  )
}
