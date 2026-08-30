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

/** In-flight tones (spec §3 / handoff "Motion": "status dots pulse 1.5s ease-in-out (only for
 *  in-flight states)") — the pipeline's active-class states. `blocked`/`done`/`paused`/`idle`
 *  are at-rest states and stay static. */
const IN_FLIGHT_TONES: ReadonlySet<StatusTone> = new Set(['working', 'planning', 'review', 'waiting'])

/** The `1a`-alpha fill / `3d`-alpha border pill (spec §3). Presentational only — callers own
 *  what `tone` means for their domain object. */
export function StatusPill({
  tone,
  label,
  pulse,
}: {
  readonly tone: StatusTone
  readonly label: string
  /**
   * Overrides the tone's own in-flight default. `lib/tones.ts`'s `CARD_STATE_TONE` supplies it,
   * because pulse is a fact about the STATE and two states can share one tone: `pause_requested`
   * ("PAUSING") rides the amber `waiting` tone and pulses, while plain `waiting` does not.
   * Omitted, the pre-M14 `IN_FLIGHT_TONES` rule applies unchanged, so every M11/M12 call site
   * (`RosterTable`, `WorkersTable`, `ProjectsClient`) keeps exactly the behaviour it has.
   */
  readonly pulse?: boolean
}): React.JSX.Element {
  const shouldPulse = pulse ?? IN_FLIGHT_TONES.has(tone)
  const pulseClass = shouldPulse ? 'motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]' : ''
  return (
    <span
      data-testid="status-pill"
      data-tone={tone}
      className={`inline-flex items-center gap-1.5 rounded-pill border px-[7px] py-[3px] font-mono text-[9.5px] uppercase tracking-wide ${TONE_FILL[tone]} ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}
    >
      <span aria-hidden className={`h-[5px] w-[5px] rounded-full ${TONE_DOT[tone]} ${pulseClass}`} />
      {label}
    </span>
  )
}
