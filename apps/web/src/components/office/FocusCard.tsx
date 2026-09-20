'use client'

import { useState } from 'react'
import type { LiveStatus } from '../../lib/office/liveOffice'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

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
  /** Who this slave is waiting on an answer from (M36 t3), or `null`. See `LiveSlave.waitingFor`. */
  readonly waitingFor: string | null
}

/**
 * The focused slave (M28 §5–§6, M61 R17): who, what, how far, and the run's Pause/Resume/Stop --
 * a `Card` beside the canvas now, not a floating overlay on top of it. The buttons call back with
 * the action; the caller talks to the run routes and returns the refusal text (or null), which
 * stays on the card until the next action.
 */
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
  // M36 t3: a run waiting for another slave's answer is `paused`, but it is NOT a human pause --
  // nobody should be invited to resume it by hand, and the thing that will continue it is the
  // answer. Same rule `SlaveCard`/`SlavePanel` follow for the same field.
  const waitingFor = view.waitingFor
  const runAction = async (action: 'pause' | 'resume' | 'stop'): Promise<void> => {
    if (view.runId === null) return
    setPending(true)
    setError(await onRun(view.runId, action))
    setPending(false)
  }
  return (
    <Card testId="office-focus" className="gap-[10px]">
      <div className="flex items-center gap-2">
        {/* Per-slave colour, from the office engine's own palette -- not a design token, and not
          * a "colour literal" in the sense the redesign forbids: the canvas draws thirty distinct
          * sprites and this is the one place their identity carries off it. */}
        <div
          className="grid h-7 w-7 flex-none place-items-center rounded-tile border text-[10px] font-semibold"
          style={{ background: `${view.color}1a`, borderColor: `${view.color}3d`, color: view.color }}
        >
          {view.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate type-body font-semibold">{view.name}</div>
          <div className="truncate type-meta text-t3">
            {view.role} · {view.department}
          </div>
        </div>
        <span className="type-meta ml-auto whitespace-nowrap font-medium" style={{ color: view.statusColor }}>
          ● {view.status}
        </span>
      </div>
      <div className="truncate type-body">
        <span className="type-meta text-t3">{view.taskKey}</span> {view.taskTitle}
      </div>
      <div className="h-[3px] rounded-sm bg-sel">
        <div
          className="h-full rounded-sm transition-[width] duration-500"
          style={{ width: `${view.pct}%`, background: view.statusColor }}
        />
      </div>
      {waitingFor !== null && (
        <span data-testid="office-focus-waiting" className="type-meta truncate text-tone-waiting">
          waiting for {waitingFor}
        </span>
      )}
      <div className="flex gap-[5px]">
        {!archived && waitingFor === null && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="office-focus-pause"
            disabled={pending || view.runId === null || view.status === 'pausing'}
            onClick={() => void runAction(paused ? 'resume' : 'pause')}
            className="flex-1"
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
        )}
        <Button variant="ghost" size="sm" data-testid="office-focus-next" onClick={onNext} className="flex-1">
          Next ⇄
        </Button>
        {!archived && (
          <Button
            variant="danger"
            size="sm"
            data-testid="office-focus-stop"
            disabled={pending || view.runId === null}
            onClick={() => void runAction('stop')}
          >
            Stop
          </Button>
        )}
      </div>
      {error !== null && (
        <span role="alert" data-testid="office-focus-error" className="type-meta text-tone-blocked">
          {error}
        </span>
      )}
    </Card>
  )
}
