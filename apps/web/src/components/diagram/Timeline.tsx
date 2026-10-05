'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BuildDiagram } from '@slave-of-ai/control'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatUsd, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { sessionName } from './NodeSheet'
import type { DiagramSubject } from './TeamDiagram'
import { ZOOM_WORD, barsOf, lanesOf, scaleOf, spanOf, ticksOf, xOf, type Bar, type BarTone, type Lane, type Zoom } from './timeline'
import { endOf, formatClock, formatDuration } from './words'

const ROW = 22
const PAD = 6
const AXIS = 28
const BAND = 24
const ZOOMS: readonly Zoom[] = ['fit', '15m', '1h']

const BAR_TONE: Readonly<Record<BarTone, string>> = { ok: 'bg-success', error: 'bg-destructive', running: 'bg-info', unknown: 'bg-muted-foreground/50' }
const TONE_WORD: Readonly<Record<BarTone, string>> = { ok: 'Done', error: 'Failed', running: 'Running', unknown: 'Ended without a result' }
/** A pause, hatched in the colour of waiting. */
const HATCH = 'repeating-linear-gradient(135deg, color-mix(in oklch, var(--warning) 32%, transparent) 0 4px, transparent 4px 9px)'

const laneHeight = (lane: Lane): number => lane.rows * ROW + PAD * 2

/** What a block says when the pointer is on it: one step in full, or several in sum. */
export function barWords(bar: Bar, who: string, end: number): { readonly title: string; readonly lines: readonly string[] } {
  const first = bar.calls[0]
  const last = bar.calls.at(-1)
  if (first === undefined || last === undefined) return { title: who, lines: [] }
  const from = Date.parse(first.at)
  const to = last.endedAt === null ? end : Date.parse(last.endedAt)
  if (bar.calls.length === 1) {
    return { title: first.text, lines: [who, `${bar.tone === 'running' ? 'Running for' : 'Took'} ${formatDuration(to - from)} · ${TONE_WORD[bar.tone]}`, `${formatClock(from, true)}${bar.open ? '' : ` to ${formatClock(to, true)}`}`] }
  }
  const failed = bar.calls.filter((call) => call.outcome === 'error').length
  return {
    title: `${String(bar.calls.length)} steps`,
    lines: [who, `${formatClock(from, true)} to ${formatClock(to, true)}${failed === 0 ? '' : ` · ${String(failed)} failed`}`, ...bar.calls.slice(-3).map((call) => call.text)],
  }
}

/**
 * The build in time: one lane per person, a block per step from its call to its result, the
 * lead's turns as bands behind them with their name and cost, and a pause hatched. Fit shows the
 * whole build; the other zooms put fifteen minutes or an hour in view and scroll, newest at the
 * right. Narrow steps that touch are drawn as one block, so a long build stays light.
 */
export function Timeline({ build, onSelect }: { readonly build: BuildDiagram; readonly onSelect: (subject: DiagramSubject) => void }): React.JSX.Element {
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [viewport, setViewport] = useState(800)
  const [hover, setHover] = useState<{ readonly bar: Bar; readonly who: string; readonly left: number; readonly top: number } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const read = (): void => {
      if (element.clientWidth > 0) setViewport(element.clientWidth)
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return (): void => observer.disconnect()
  }, [])

  const end = endOf(build)
  const live = build.to === null
  const scale = useMemo(() => scaleOf(build, zoom, viewport), [build, zoom, viewport])
  const lanes = useMemo(() => lanesOf(build), [build])
  const bars = useMemo(() => lanes.map((lane) => barsOf(lane, build.calls, scale, end)), [lanes, build.calls, scale, end])
  const ticks = useMemo(() => ticksOf(scale), [scale])
  const turns = build.sessions.filter((session) => session.nodeId === 'lead')
  const height = lanes.reduce((total, lane) => total + laneHeight(lane), 0)

  // A zoom opens on the newest part: that is where a person following a build is looking.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element !== null) element.scrollLeft = element.scrollWidth
  }, [zoom, scale.width])

  const point = (bar: Bar, who: string, target: HTMLElement): void => {
    const frame = card.current?.getBoundingClientRect()
    const box = target.getBoundingClientRect()
    if (frame === undefined) return
    setHover({ bar, who, left: Math.min(Math.max(8, box.left - frame.left), Math.max(8, frame.width - 296)), top: box.bottom - frame.top + 8 })
  }
  const words = hover === null ? null : barWords(hover.bar, hover.who, end)
  const span = Math.max(0, end - Date.parse(build.from))

  return (
    <Card data-testid="timeline" ref={card} className="relative">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <CardTitle className="text-base">Timeline</CardTitle>
          <CardDescription suppressHydrationWarning>
            {formatClock(Date.parse(build.from))} to {live ? 'now' : formatClock(end)} · {formatDuration(span)} · {plural(build.totalCalls, 'step')}
            {build.calls.length < build.totalCalls && ` · the newest ${String(build.calls.length)} are drawn`}
            {scale.cut && ' · this zoom starts after the build did; Fit shows it all'}
          </CardDescription>
        </div>
        <div role="group" aria-label="Zoom" className="flex shrink-0 gap-1 rounded-lg border p-0.5">
          {ZOOMS.map((one) => (
            <Button key={one} size="sm" variant={zoom === one ? 'secondary' : 'ghost'} aria-pressed={zoom === one} data-testid={`zoom-${one}`} className="h-7 px-2.5 text-xs" onClick={() => setZoom(one)}>
              {ZOOM_WORD[one]}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex overflow-hidden rounded-lg border">
          <div className="w-28 shrink-0 border-r bg-muted/40 sm:w-40">
            <div style={{ height: AXIS + BAND }} className="flex items-end border-b px-2 pb-1 text-[11px] text-muted-foreground">
              Lead turns
            </div>
            {lanes.map((lane) => (
              <button
                key={lane.node.id}
                type="button"
                data-testid="timeline-lane"
                style={{ height: laneHeight(lane) }}
                className="flex w-full min-w-0 flex-col justify-center border-b px-2 text-left last:border-b-0 hover:bg-muted"
                onClick={() => onSelect({ nodeId: lane.node.id, sessionId: null })}
              >
                <span className="w-full truncate text-xs font-medium" title={lane.node.name}>{lane.node.name}</span>
                <span className="w-full truncate text-[11px] text-muted-foreground">
                  {plural(lane.node.toolCalls, 'step')}
                  {lane.rows > 1 && ` · ${String(lane.rows)} at once`}
                </span>
              </button>
            ))}
          </div>
          <div ref={scroller} data-testid="timeline-scroll" className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
            <div className="relative overflow-clip" style={{ width: scale.width, height: AXIS + BAND + height }} onMouseLeave={() => setHover(null)}>
              {/* The lead's turns: a band behind every lane, named above them. */}
              {turns.map((turn, index) => {
                const box = spanOf(scale, Date.parse(turn.startedAt), turn.endedAt === null ? end : Date.parse(turn.endedAt))
                if (box === null) return null
                return (
                  <div key={turn.id} data-testid="timeline-turn" className={cn('absolute bottom-0 border-l border-info/50', index % 2 === 0 ? 'bg-info/[0.06]' : 'bg-info/[0.02]')} style={{ left: box.x, width: box.width, top: AXIS }}>
                    <div style={{ height: BAND }} className="overflow-clip border-b border-info/20 text-[11px] leading-6 whitespace-nowrap text-info-foreground">
                      <span className="sticky left-0 inline-block px-1.5 font-medium">
                        {String(index + 1)}. {sessionName(turn, index)}
                        <span className="font-normal text-muted-foreground"> · {turn.costUsd === null ? (turn.endedAt === null ? 'cost when it ends' : 'cost not reported') : formatUsd(turn.costUsd)}</span>
                      </span>
                    </div>
                  </div>
                )
              })}
              {/* The axis. */}
              <div className="absolute inset-x-0 top-0 border-b" style={{ height: AXIS }}>
                {ticks.map((tick) => (
                  <span key={tick.x} className="absolute top-0 h-full border-l pl-1 text-[11px] leading-7 whitespace-nowrap text-muted-foreground tabular-nums" style={{ left: tick.x }} suppressHydrationWarning>
                    {tick.label}
                  </span>
                ))}
              </div>
              {ticks.map((tick) => (
                <span key={tick.x} aria-hidden className="absolute bottom-0 border-l border-border/50" style={{ left: tick.x, top: AXIS + BAND }} />
              ))}
              {/* When the build stood paused: under the lanes, so a step on it can still be pointed at. */}
              {build.pauses.map((pause) => {
                const from = Date.parse(pause.from)
                const box = spanOf(scale, from, pause.to === null ? Math.max(scale.to, from + 1) : Date.parse(pause.to))
                if (box === null) return null
                return <span key={pause.from} data-testid="timeline-pause" aria-label={`Paused at ${formatClock(from, true)}`} className="pointer-events-none absolute bottom-0 border-l border-warning" style={{ left: box.x, width: Math.max(box.width, 4), top: AXIS + BAND, backgroundImage: HATCH }} />
              })}
              {/* The lanes: each session a pale span, each step a block on it. */}
              {lanes.map((lane, laneIndex) => {
                const top = AXIS + BAND + lanes.slice(0, laneIndex).reduce((total, one) => total + laneHeight(one), 0)
                const checker = lane.node.kind === 'checker'
                return (
                  <div key={lane.node.id} className="absolute inset-x-0 border-b last:border-b-0" style={{ top, height: laneHeight(lane) }}>
                    {lane.sessions.map((session) => {
                      const box = spanOf(scale, Date.parse(session.startedAt), session.endedAt === null ? end : Date.parse(session.endedAt))
                      if (box === null || lane.node.kind === 'lead') return null
                      return <span key={session.id} data-testid="timeline-session" className={cn('absolute rounded-sm', checker ? 'bg-checking/20' : 'bg-success/15')} style={{ left: box.x, width: Math.max(box.width, 3), top: PAD + (lane.rowOf.get(session.id) ?? 0) * ROW + 2, height: ROW - 4 }} />
                    })}
                    {(bars[laneIndex] ?? []).map((bar) => (
                      <button
                        key={bar.key}
                        type="button"
                        tabIndex={-1}
                        data-testid="timeline-bar"
                        data-tone={bar.tone}
                        data-steps={bar.calls.length}
                        aria-label={`${lane.node.name}: ${bar.calls.length === 1 ? (bar.calls[0]?.text ?? '') : `${String(bar.calls.length)} steps`}`}
                        className={cn('absolute rounded-[2px] hover:brightness-110 hover:outline hover:outline-1 hover:outline-foreground/60', bar.tone === 'running' && checker ? 'bg-checking' : BAR_TONE[bar.tone], bar.open && live && 'animate-pulse')}
                        style={{ left: bar.x, width: bar.width, top: PAD + bar.row * ROW + 5, height: ROW - 10 }}
                        onMouseEnter={(event) => point(bar, lane.node.name, event.currentTarget)}
                        onClick={() => onSelect({ nodeId: lane.node.id, sessionId: lane.node.kind === 'helper' ? (bar.calls[0]?.sessionId ?? null) : null })}
                      />
                    ))}
                  </div>
                )
              })}
              {live && <span aria-hidden data-testid="timeline-now" className="absolute bottom-0 w-px bg-info" style={{ left: xOf(scale, end), top: AXIS }} />}
            </div>
          </div>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {(['ok', 'error', 'running'] as const).map((tone) => (
            <li key={tone} className="flex items-center gap-1.5">
              <span className={cn('h-2.5 w-4 rounded-[2px]', BAR_TONE[tone])} />
              {TONE_WORD[tone]}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-4 rounded-[2px] border border-warning" style={{ backgroundImage: HATCH }} />
            Paused
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-4 rounded-[2px] bg-info/15 ring-1 ring-info/40" />A turn of the lead
          </li>
        </ul>
      </CardContent>
      {hover !== null && words !== null && (
        <div role="tooltip" data-testid="timeline-tip" className="pointer-events-none absolute z-20 w-72 rounded-md border bg-popover p-2.5 text-xs text-popover-foreground shadow-md" style={{ left: hover.left, top: hover.top }}>
          <p className="font-medium break-words">{words.title}</p>
          {words.lines.map((line, index) => (
            <p key={`${String(index)}-${line}`} className="truncate text-muted-foreground" suppressHydrationWarning>
              {line}
            </p>
          ))}
        </div>
      )}
    </Card>
  )
}
