'use client'

import { plural } from '../../lib/plural'

export interface HudView {
  readonly connection: 'connected' | 'reconnecting'
  readonly departments: number
  readonly slaves: number
  readonly working: number
  readonly todLabel: string
  readonly clock: string
  readonly hour: number
  readonly live: boolean
  readonly zoom: string
}

const PIXEL = '[font-family:var(--font-pixel),monospace] text-[9px]'

/** The design's four overlays (M28 §5): counts + stream state (top-left), clock + hour slider +
 *  LIVE (top-centre), legend (bottom-left), zoom (bottom-right). Pure: every value arrives composed. */
export function OfficeHud({
  view,
  onHour,
  onLive,
  onZoom,
}: {
  readonly view: HudView
  readonly onHour: (hour: number) => void
  readonly onLive: () => void
  readonly onZoom: (dir: 1 | -1) => void
}): React.JSX.Element {
  return (
    <>
      <div className={`absolute left-3 top-3 flex items-center gap-2 rounded bg-[rgba(8,9,12,.7)] px-2 py-1 text-text-body ${PIXEL}`}>
        <span data-testid="office-stream" className={view.connection === 'connected' ? 'text-tone-done' : 'text-tone-waiting'}>
          {view.connection === 'connected' ? '● LIVE' : '● RECONNECTING'}
        </span>
        <span data-testid="office-hud-counts" className="text-text-3">
          {plural(view.departments, 'department')} · {plural(view.slaves, 'slave')} · {view.working} working
        </span>
      </div>
      <div className={`absolute left-1/2 top-3 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-[10px] rounded-md bg-[rgba(8,9,12,.78)] px-[10px] py-[5px] text-text-body ${PIXEL}`}>
        <span className="whitespace-nowrap text-tone-waiting">
          <span data-testid="office-tod">{view.todLabel}</span> · <span data-testid="office-clock">{view.clock}</span>
        </span>
        <input
          type="range"
          data-testid="office-hour"
          min={0}
          max={24}
          step={0.25}
          value={view.hour}
          onChange={(event) => onHour(Number.parseFloat(event.target.value))}
          className="w-[clamp(90px,22vw,200px)] cursor-pointer accent-tone-waiting"
          aria-label="hour of day"
        />
        <button
          type="button"
          data-testid="office-live"
          onClick={onLive}
          className={`rounded border border-[rgba(255,255,255,.12)] px-2 py-[3px] ${PIXEL} ${view.live ? 'bg-[#4ade8022] text-tone-done' : 'bg-transparent text-text-3'}`}
        >
          LIVE
        </button>
      </div>
      <div data-testid="office-legend" className={`absolute bottom-3 left-3 flex flex-wrap gap-[10px] rounded bg-[rgba(8,9,12,.7)] px-2 py-1 text-text-3 ${PIXEL}`}>
        <span className="text-tone-working">■ working</span>
        <span className="text-tone-blocked">■ blocked</span>
        <span className="text-text-2">■ paused</span>
        <span>· scroll zoom · drag pan · click focus</span>
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-chip bg-[rgba(8,9,12,.7)] p-1">
        <button type="button" data-testid="office-zoom-out" aria-label="zoom out" onClick={() => onZoom(-1)} className="h-[22px] w-6 rounded border border-[rgba(255,255,255,.12)] font-mono text-[13px] text-text-body">
          −
        </button>
        <span data-testid="office-zoom" className={`min-w-[30px] text-center text-text-body ${PIXEL}`}>
          {view.zoom}
        </span>
        <button type="button" data-testid="office-zoom-in" aria-label="zoom in" onClick={() => onZoom(1)} className="h-[22px] w-6 rounded border border-[rgba(255,255,255,.12)] font-mono text-[13px] text-text-body">
          +
        </button>
      </div>
    </>
  )
}
