import type { BuildDiagram, DiagramResult, DiagramState } from '@slave-of-ai/control'

/** The colour of a state, by the design's own tokens: blue builds, violet checks, amber waits, green is done, red failed. */
export type Tone = 'info' | 'checking' | 'warning' | 'success' | 'destructive' | 'muted'

export const STATE_WORD: Readonly<Record<DiagramState, string>> = { working: 'Working', paused: 'Paused', done: 'Finished', failed: 'Failed' }

export const RESULT_WORD: Readonly<Record<DiagramResult, string>> = {
  merged: 'Merged',
  waiting_for_you: 'Waiting for you',
  left_unmerged: 'Left unmerged',
  not_yet: 'Not there yet',
}

const RESULT_TONE: Readonly<Record<DiagramResult, Tone>> = { merged: 'success', waiting_for_you: 'warning', left_unmerged: 'muted', not_yet: 'muted' }

/** A person's colour: what they are, while they work; how it went, after. */
export function toneOfState(state: DiagramState, checker: boolean): Tone {
  if (state === 'working') return checker ? 'checking' : 'info'
  if (state === 'paused') return 'warning'
  return state === 'failed' ? 'destructive' : 'success'
}

export function toneOfResult(result: DiagramResult): Tone {
  return RESULT_TONE[result]
}

/** The colour as a CSS value, for a line drawn in SVG. */
export const TONE_STROKE: Readonly<Record<Tone, string>> = {
  info: 'var(--info)',
  checking: 'var(--checking)',
  warning: 'var(--warning)',
  success: 'var(--success)',
  destructive: 'var(--destructive)',
  muted: 'var(--muted-foreground)',
}

export const TONE_BADGE: Readonly<Record<Tone, string>> = {
  info: 'bg-info-muted text-info-foreground',
  checking: 'bg-checking-muted text-checking-foreground',
  warning: 'bg-warning-muted text-warning-foreground',
  success: 'bg-success-muted text-success-foreground',
  destructive: 'bg-destructive/15 text-destructive',
  muted: 'bg-muted text-muted-foreground',
}

/** A card's left edge, the one stroke of colour on it. */
export const TONE_EDGE: Readonly<Record<Tone, string>> = {
  info: 'border-l-info',
  checking: 'border-l-checking',
  warning: 'border-l-warning',
  success: 'border-l-success',
  destructive: 'border-l-destructive',
  muted: 'border-l-muted-foreground/40',
}

/** "4 s", "2 min 5 s", "1 h 3 min": how long a step or a session took. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 1) return 'under a second'
  if (seconds < 60) return `${String(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds % 60)} s`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`
}

/** The clock time of an instant, to the second when asked: "15:51", "15:51:06". */
export function formatClock(ms: number, seconds = false): string {
  const date = new Date(ms)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}${seconds ? `:${two(date.getSeconds())}` : ''}`
}

/** Where a build's time ends: its last instant, or the moment it was read while somebody works. */
export function endOf(build: Pick<BuildDiagram, 'to' | 'at'>): number {
  return Date.parse(build.to ?? build.at)
}
