import type { BuildDiagram, DiagramCall, DiagramNode, DiagramSession } from '@slave-of-ai/control'
import { endOf, formatClock } from './words'

export type Zoom = 'fit' | '15m' | '1h'
export const ZOOM_WORD: Readonly<Record<Zoom, string>> = { fit: 'Fit', '15m': 'Last 15 min', '1h': 'Last hour' }
const ZOOM_MS: Readonly<Record<Exclude<Zoom, 'fit'>, number>> = { '15m': 15 * 60_000, '1h': 60 * 60_000 }

/** The widest the drawing gets: past it, a zoomed timeline shows the build's newest part only. */
export const MAX_WIDTH = 48_000
/** The narrowest a step is drawn. Steps this narrow that touch are drawn as one block. */
export const MIN_BAR = 3

/** Time to pixels: `from`..`to` in milliseconds across `width` pixels. */
export interface Scale {
  readonly from: number
  readonly to: number
  readonly width: number
  /** The drawing starts after the build did: older steps are out of it. */
  readonly cut: boolean
}

export const xOf = (scale: Scale, at: number): number => ((at - scale.from) / (scale.to - scale.from)) * scale.width

/**
 * The scale of a zoom. Fit puts the whole build in the viewport. The others put that much time
 * in the viewport and let the rest scroll, the newest at the right; a build too long to draw at
 * that scale within `MAX_WIDTH` is cut at its old end.
 */
export function scaleOf(build: Pick<BuildDiagram, 'from' | 'to' | 'at'>, zoom: Zoom, viewport: number): Scale {
  const start = Date.parse(build.from)
  const end = Math.max(endOf(build), start + 1000)
  // A little air after the last instant, so an open step's end is not on the edge.
  const to = end + Math.max(2000, (end - start) * 0.02)
  const width = Math.max(240, viewport)
  if (zoom === 'fit' || to - start <= ZOOM_MS[zoom]) return { from: start, to, width, cut: false }
  const perMs = width / ZOOM_MS[zoom]
  const whole = (to - start) * perMs
  if (whole <= MAX_WIDTH) return { from: start, to, width: whole, cut: false }
  return { from: to - MAX_WIDTH / perMs, to, width: MAX_WIDTH, cut: true }
}

/** One lane of the timeline: a person, with one row per session of theirs open at the same time. */
export interface Lane {
  readonly node: DiagramNode
  readonly rows: number
  /** Which row each session is drawn on. */
  readonly rowOf: ReadonlyMap<string, number>
  readonly sessions: readonly DiagramSession[]
}

/**
 * The lanes: the lead, each helper, the checkers. A person's sessions that overlap in time (a
 * helper called three times at once) each get a row of their own, the first free one.
 */
export function lanesOf(build: BuildDiagram): readonly Lane[] {
  const end = endOf(build)
  return build.nodes
    .filter((node) => node.kind === 'lead' || node.kind === 'helper' || node.kind === 'checker')
    .map((node) => {
      const sessions = build.sessions.filter((session) => session.nodeId === node.id)
      const busyUntil: number[] = []
      const rowOf = new Map<string, number>()
      for (const session of sessions) {
        const from = Date.parse(session.startedAt)
        const to = session.endedAt === null ? Math.max(end, from) : Date.parse(session.endedAt)
        let row = busyUntil.findIndex((until) => until <= from)
        if (row === -1) row = busyUntil.length
        busyUntil[row] = to
        rowOf.set(session.id, row)
      }
      return { node, rows: Math.max(1, busyUntil.length), rowOf, sessions }
    })
}

export type BarTone = 'ok' | 'error' | 'running' | 'unknown'

/** One block of a lane: a step, or several narrow ones that touch. */
export interface Bar {
  readonly key: string
  readonly row: number
  readonly x: number
  readonly width: number
  readonly tone: BarTone
  /** The steps in it, oldest first; more than one when narrow steps were drawn together. */
  readonly calls: readonly DiagramCall[]
  /** Still running: its end is "now". */
  readonly open: boolean
}

const toneOfCall = (call: DiagramCall): BarTone => call.outcome ?? (call.endedAt === null ? 'running' : 'unknown')
/** The widest a block of narrow steps grows: past it a new block begins, so a block still says when. */
export const MAX_BLOCK = 24
const ORDER: Readonly<Record<BarTone, number>> = { ok: 0, unknown: 1, running: 2, error: 3 }

/**
 * A lane's steps as blocks at a scale. Each step runs from its call to its result (an open one
 * to the build's end); none is drawn narrower than `MIN_BAR`. Narrow steps that touch on the same
 * row and went the same way become one block, which says how many it holds -- so a build of
 * thousands of steps draws a few hundred blocks, not thousands. A failed step is never folded
 * into the ones that worked: it is drawn after them, on top, so it is always seen.
 */
export function barsOf(lane: Lane, calls: readonly DiagramCall[], scale: Scale, end: number): readonly Bar[] {
  interface Block { key: string; row: number; x: number; width: number; tone: BarTone; calls: DiagramCall[]; open: boolean; narrow: boolean }
  const lastOf = new Map<string, Block>()
  const bars: Block[] = []
  for (const call of calls) {
    if (call.nodeId !== lane.node.id) continue
    const from = Date.parse(call.at)
    const to = call.endedAt === null ? end : Date.parse(call.endedAt)
    if (to < scale.from) continue
    const x = Math.max(0, xOf(scale, from))
    const natural = xOf(scale, Math.max(to, from)) - x
    const narrow = natural <= MIN_BAR
    const width = Math.max(MIN_BAR, natural)
    const row = lane.rowOf.get(call.sessionId) ?? 0
    const tone = toneOfCall(call)
    const slot = `${String(row)}:${tone}`
    const before = lastOf.get(slot)
    if (before !== undefined && before.narrow && narrow && x <= before.x + before.width + 1 && x + width - before.x <= MAX_BLOCK) {
      before.width = Math.max(before.width, x + width - before.x)
      before.calls.push(call)
      before.open ||= call.endedAt === null
      continue
    }
    const bar: Block = { key: call.id, row, x, width, tone, calls: [call], open: call.endedAt === null, narrow }
    bars.push(bar)
    lastOf.set(slot, bar)
  }
  return bars.sort((a, b) => ORDER[a.tone] - ORDER[b.tone])
}

const STEPS = [5_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000]

/** The axis: round clock times, about one every 110 pixels. */
export function ticksOf(scale: Scale): readonly { readonly x: number; readonly label: string }[] {
  const wanted = ((scale.to - scale.from) / scale.width) * 110
  const step = STEPS.find((one) => one >= wanted) ?? STEPS.at(-1) ?? 60_000
  // Rounded in local time, so a tick reads 16:00 and not 16:00 in another zone.
  const offset = new Date(scale.from).getTimezoneOffset() * 60_000
  const first = Math.ceil((scale.from - offset) / step) * step + offset
  const ticks: { x: number; label: string }[] = []
  for (let at = first; at <= scale.to && ticks.length < 600; at += step) ticks.push({ x: xOf(scale, at), label: formatClock(at, step < 60_000) })
  return ticks
}

/** A stretch of time as a box on the drawing, cut to it; null when it is all outside. */
export function spanOf(scale: Scale, from: number, to: number): { readonly x: number; readonly width: number } | null {
  if (to <= scale.from || from >= scale.to) return null
  const x = Math.max(0, xOf(scale, from))
  return { x, width: Math.max(1, Math.min(scale.width, xOf(scale, to)) - x) }
}
