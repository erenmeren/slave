import type { OverviewSnapshot } from '../server/overview'
import { CARD_STATE_TONE } from '../lib/tones'
import { TONE_TEXT, type StatusTone } from './ui/StatusPill'

/**
 * The handoff's 6-up summary strip (design README "1a" / §3a.1): **slaves working · tasks active ·
 * tasks ready · tasks done · blocked · spend**, in that order, over 1px gutters so the section's
 * own `bg-line` shows THROUGH the grid as the hairline between tiles. `22px` mono numerals at
 * `letter-spacing: -1px`, an 11px label beneath.
 *
 * This replaces the M11 strip's three slave buckets (working / paused / idle). `paused` and
 * `idle` are not among the handoff's six, and a paused slave already says so on its own card's
 * pill -- the strip answers "how much work is moving", not "what is each slave doing".
 *
 * Tones come from `lib/tones.ts`'s `CARD_STATE_TONE`, never a second hand-written map (Decision
 * 2), and only ever light up a NON-ZERO count: zero is not a state worth colouring, and a red
 * `0` beside the word "blocked" reads as an alarm about nothing.
 */
export function TopStrip({ snapshot }: { readonly snapshot: OverviewSnapshot }): React.JSX.Element {
  const working = snapshot.slaves.filter((a) => a.status === 'working').length
  const { active, ready, done, blocked } = snapshot.tasks
  const tiles: ReadonlyArray<{
    readonly key: string
    readonly value: string
    readonly label: string
    readonly tone?: StatusTone
  }> = [
    { key: 'slaves-working', value: String(working), label: 'slaves working', ...(working > 0 ? { tone: CARD_STATE_TONE.working.tone } : {}) },
    { key: 'tasks-active', value: String(active), label: 'tasks active', ...(active > 0 ? { tone: CARD_STATE_TONE.working.tone } : {}) },
    // `ready` carries no tone: a queued task is neither in flight nor a problem, and the handoff
    // gives it the same neutral numeral the spend tile has.
    { key: 'tasks-ready', value: String(ready), label: 'tasks ready' },
    { key: 'tasks-done', value: String(done), label: 'tasks done', ...(done > 0 ? { tone: CARD_STATE_TONE.completed.tone } : {}) },
    { key: 'blocked', value: String(blocked), label: 'blocked', ...(blocked > 0 ? { tone: CARD_STATE_TONE.blocked.tone } : {}) },
    // KNOWN spend (`sumSpend`), never a guess. The count of runs nobody could measure rides
    // underneath as its own line rather than being folded in -- Decision 6: `$3.00` on its own
    // would read as the total when part of the total is unrecoverable.
    { key: 'spend', value: `$${snapshot.workspace.spentUsd.toFixed(2)}`, label: 'spend' },
  ]

  return (
    <section data-testid="strip" className="grid grid-cols-6 gap-px border-b border-line bg-line">
      {tiles.map((tile) => (
        <div key={tile.key} data-testid="strip-tile" data-strip={tile.key} className="flex flex-col gap-[2px] bg-bg-1 px-[15px] py-[13px]">
          <span
            data-testid={`strip-value-${tile.key}`}
            className={`font-mono text-[22px] font-semibold leading-none tracking-[-1px] ${
              tile.tone !== undefined ? TONE_TEXT[tile.tone] : 'text-text-1'
            }`}
          >
            {tile.value}
          </span>
          <span className="truncate text-[11px] text-text-2">{tile.label}</span>
          {tile.key === 'spend' && snapshot.workspace.unmeasuredRuns > 0 && (
            <span data-testid="strip-unmeasured" className="font-mono text-[9.5px] text-tone-waiting">
              {snapshot.workspace.unmeasuredRuns} unmeasured
            </span>
          )}
        </div>
      ))}
    </section>
  )
}
