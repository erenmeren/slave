/**
 * The handoff status vocabulary (spec §3) — independent of the older M4 `AgentCardData['status']`
 * / `TaskStatus` vocabularies (`AgentCard.tsx`'s `DOT`, `TaskCard.tsx`'s `TASK_STATUS_DOT`, etc.):
 * this is the tone set the `ui/` component library itself renders. Every `ui/` component that
 * takes a `tone` prop imports this type (and, where it needs the class-per-tone pattern below,
 * the `TONE_*` maps) from here rather than redefining it.
 */
export type StatusTone = 'working' | 'planning' | 'review' | 'waiting' | 'blocked' | 'done' | 'paused' | 'idle'

/**
 * Literal per-tone class strings, not string interpolation (`` `bg-tone-${tone}/10` `` etc.) —
 * Tailwind v4 only generates a utility it can find as literal text in the source it scans, so an
 * assembled-at-runtime class name never gets generated. Same rule `TaskCard.tsx`'s
 * `TASK_STATUS_BORDER` documents for the older status vocabulary.
 *
 * Pattern (spec §3): fill at `1a` alpha (~10%), border at `3d` alpha (~24%), text/dot solid.
 */
export const TONE_FILL: Record<StatusTone, string> = {
  working: 'bg-tone-working/10',
  planning: 'bg-tone-planning/10',
  review: 'bg-tone-review/10',
  waiting: 'bg-tone-waiting/10',
  blocked: 'bg-tone-blocked/10',
  done: 'bg-tone-done/10',
  paused: 'bg-tone-paused/10',
  idle: 'bg-tone-idle/10',
}

export const TONE_BORDER: Record<StatusTone, string> = {
  working: 'border-tone-working/24',
  planning: 'border-tone-planning/24',
  review: 'border-tone-review/24',
  waiting: 'border-tone-waiting/24',
  blocked: 'border-tone-blocked/24',
  done: 'border-tone-done/24',
  paused: 'border-tone-paused/24',
  idle: 'border-tone-idle/24',
}

export const TONE_TEXT: Record<StatusTone, string> = {
  working: 'text-tone-working',
  planning: 'text-tone-planning',
  review: 'text-tone-review',
  waiting: 'text-tone-waiting',
  blocked: 'text-tone-blocked',
  done: 'text-tone-done',
  paused: 'text-tone-paused',
  idle: 'text-tone-idle',
}

export const TONE_DOT: Record<StatusTone, string> = {
  working: 'bg-tone-working',
  planning: 'bg-tone-planning',
  review: 'bg-tone-review',
  waiting: 'bg-tone-waiting',
  blocked: 'bg-tone-blocked',
  done: 'bg-tone-done',
  paused: 'bg-tone-paused',
  idle: 'bg-tone-idle',
}

/** `ProgressBar`'s "0 0 8px" glow (spec §3), solid tone colour — an arbitrary-value literal per
 *  tone since the glow colour has to reach into `--color-tone-*` and Tailwind has no bare
 *  "glow" utility to modify with a class-name-safe opacity suffix. */
export const TONE_GLOW: Record<StatusTone, string> = {
  working: 'shadow-[0_0_8px_var(--color-tone-working)]',
  planning: 'shadow-[0_0_8px_var(--color-tone-planning)]',
  review: 'shadow-[0_0_8px_var(--color-tone-review)]',
  waiting: 'shadow-[0_0_8px_var(--color-tone-waiting)]',
  blocked: 'shadow-[0_0_8px_var(--color-tone-blocked)]',
  done: 'shadow-[0_0_8px_var(--color-tone-done)]',
  paused: 'shadow-[0_0_8px_var(--color-tone-paused)]',
  idle: 'shadow-[0_0_8px_var(--color-tone-idle)]',
}

/** The `1a`-alpha fill / `3d`-alpha border pill (spec §3). Presentational only — callers own
 *  what `tone` means for their domain object. */
export function StatusPill({ tone, label }: { readonly tone: StatusTone; readonly label: string }): React.JSX.Element {
  return (
    <span
      data-testid="status-pill"
      data-tone={tone}
      className={`inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${TONE_FILL[tone]} ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} />
      {label}
    </span>
  )
}
