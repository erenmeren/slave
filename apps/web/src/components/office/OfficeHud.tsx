'use client'

import { plural } from '../../lib/plural'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'

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

/**
 * The design's overlays, one `office-toolbar` bar now (M61 R17), not four floating boxes: the
 * stream chip, the counts, the clock/time-of-day/hour slider/LIVE cluster, the legend and the
 * zoom controls, all drawn with the product's own `Chip`/`Button`/`type-*` vocabulary. No pixel
 * font anywhere in this DOM -- the canvas keeps its own (`setPixelFont`); this bar reads like
 * every other surface in the app. Every `office-*` testid it carried before still names the exact
 * same control; only the surrounding markup and classes moved.
 */
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
    <div
      data-testid="office-toolbar"
      className="glass flex h-[44px] items-center gap-[var(--gap-2)] rounded-surface border border-line px-3"
    >
      <Chip testId="office-stream" tone={view.connection === 'connected' ? 'working' : 'waiting'}>
        {view.connection === 'connected' ? 'LIVE' : 'RECONNECTING'}
      </Chip>
      <span data-testid="office-hud-counts" className="type-meta whitespace-nowrap text-t3">
        {plural(view.departments, 'department')} · {plural(view.slaves, 'slave')} · {view.working} working
      </span>
      <span className="type-meta flex items-center gap-1 whitespace-nowrap text-t3">
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
        className="w-[clamp(90px,18vw,180px)] cursor-pointer [accent-color:var(--accent)]"
        aria-label="hour of day"
      />
      <Button
        variant="ghost"
        size="sm"
        data-testid="office-live"
        onClick={onLive}
        className={view.live ? 'text-tone-done' : ''}
      >
        LIVE
      </Button>
      <div data-testid="office-legend" className="type-meta ml-auto flex flex-wrap items-center gap-[10px] text-t3">
        <Chip testId="office-legend-working" tone="working">
          working
        </Chip>
        <Chip testId="office-legend-blocked" tone="blocked">
          blocked
        </Chip>
        <Chip testId="office-legend-paused" tone="paused">
          paused
        </Chip>
        <span className="hidden lg:inline">scroll zoom · drag pan · click focus</span>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" data-testid="office-zoom-out" aria-label="zoom out" onClick={() => onZoom(-1)}>
          −
        </Button>
        <span data-testid="office-zoom" className="type-meta min-w-[30px] text-center text-t3">
          {view.zoom}
        </span>
        <Button variant="ghost" size="sm" data-testid="office-zoom-in" aria-label="zoom in" onClick={() => onZoom(1)}>
          +
        </Button>
      </div>
    </div>
  )
}
