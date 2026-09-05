'use client'

import Link from 'next/link'
import type { ShellFacts } from '../../server/shell'
import { useShellFacts } from '../../hooks/useShellFacts'
import { useStreamState } from '../../hooks/useStreamState'
import { EmergencyStopButton } from '../EmergencyStopButton'
import { ProjectSwitcher } from './ProjectSwitcher'

// The mockup's own connection chip (`Slave of AI Web.dc.html:38-41`), not `ui/Chip.tsx`'s neutral
// recipe: a radius-20 pill, `3px 9px`, a 1px status border at 25% alpha over a 6% fill, and a
// `500 10px` mono label in the status colour beside a 5px dot. `Chip` cannot render it -- it takes
// only `tone`/`children`, has no `data-testid` passthrough (this badge's `connection` test-id must
// stay put) and uses the 5px chip radius. The mock draws only the connected state; `reconnecting`
// takes the same geometry in the warn tone, because a chip that keeps the live colour while the
// stream is down is the lie Decision 3 forbids. A third, `idle`, state takes the same geometry in
// a faint neutral tone with no pulse: no page publishes a stream on the Settings tab (M24 final
// review, Important 2), and a live teal pulse there would claim a connection that does not exist.
const CONNECTION_CHIP_BASE =
  'inline-flex items-center gap-[6px] rounded-pill border px-[9px] py-[3px] font-mono text-[10px] font-medium'
const CONNECTION_CHIP_TONE = {
  connected: 'border-tone-working/25 bg-tone-working/[0.06] text-tone-working',
  reconnecting: 'border-tone-waiting/25 bg-tone-waiting/[0.06] text-tone-waiting',
  idle: 'border-line text-text-faint',
} as const
const CONNECTION_DOT_TONE = {
  connected: 'bg-tone-working motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]',
  reconnecting: 'bg-tone-waiting',
  idle: 'bg-text-faint',
} as const

export function ProjectHeader({
  workspaceId,
  initial,
  workspaces,
}: {
  readonly workspaceId: string
  /** The layout's server-rendered facts: what the header shows until the page's stream publishes. */
  readonly initial: ShellFacts
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
}): React.JSX.Element {
  const published = useShellFacts(workspaceId)
  const facts = published ?? initial
  const stream = useStreamState(workspaceId)
  const connection = stream === null ? 'idle' : stream.connection
  const latencyMs = stream?.latencyMs ?? null
  const connectionText = connection === 'reconnecting' ? 'reconnecting' : `sse · ${latencyMs === null ? '—' : `${latencyMs}ms`}`

  const budgetUsd = facts.guardrails.budgetUsd
  const ratio = budgetUsd === null || budgetUsd <= 0 ? 0 : facts.status.spentUsd / budgetUsd
  // Colour AND its `0 0 8px` glow in one lookup (`Slave of AI Web.dc.html:47`, and the README's
  // "status colour at ... `0 0 8px` for bar glow" pattern): the two must never disagree.
  const barColor =
    ratio >= 1
      ? 'bg-tone-blocked shadow-[0_0_8px_var(--color-tone-blocked)]'
      : ratio >= 0.8
        ? 'bg-tone-waiting shadow-[0_0_8px_var(--color-tone-waiting)]'
        : 'bg-tone-working shadow-[0_0_8px_var(--color-tone-working)]'

  return (
    <header
      data-testid="project-header"
      className="relative flex h-[52px] flex-none items-center gap-4 border-b border-line bg-bg-1 px-4"
    >
      {/* The handoff's 1px gradient hairline (design README §3a): transparent → teal .5 → indigo
        * .3 → transparent. Its own absolutely positioned element rather than a `border-bottom`,
        * because a border cannot carry a gradient -- and it sits at `bottom:-1px`, BENEATH the
        * structural hairline rather than replacing it, exactly as the mock stacks the two
        * (`Slave of AI Web.dc.html:32-33`). Without the border under it the bar's bottom edge
        * would fade to nothing at both ends, where the gradient is transparent. */}
      <span
        data-testid="project-header-hairline"
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-[linear-gradient(90deg,transparent,rgba(46,230,207,.5),rgba(123,140,255,.3),transparent)]"
      />
      <ProjectSwitcher current={facts.workspace} workspaces={workspaces} />
      <Link
        href={`/w/${workspaceId}/settings`}
        className="min-w-0 max-w-[420px] rounded-nav px-[6px] py-[3px] hover:bg-white/[0.045]"
      >
        <span data-testid="project-goal" className={`block truncate text-[11.5px] ${facts.status.goal === null ? 'text-text-3' : 'text-text-2'}`}>
          {facts.status.goal === null ? 'no goal · set one' : `Goal: ${facts.status.goal}`}
        </span>
      </Link>
      <span data-testid="connection" className={`${CONNECTION_CHIP_BASE} ${CONNECTION_CHIP_TONE[connection]}`}>
        <span className={`inline-block h-[5px] w-[5px] rounded-full ${CONNECTION_DOT_TONE[connection]}`} />
        {connectionText}
      </span>
      <span className="ml-auto flex items-center gap-3">
        <span data-testid="budget" className="flex items-center gap-2 text-xs text-text-2">
          <span className="font-mono">
            ${facts.status.spentUsd.toFixed(2)}
            {budgetUsd !== null && ` / $${budgetUsd.toFixed(2)}`}
          </span>
          {facts.status.unmeasuredRuns > 0 && (
            <span data-testid="budget-unmeasured" className="text-text-3">
              · {facts.status.unmeasuredRuns} unmeasured
            </span>
          )}
          {/* `ui/ProgressBar.tsx`'s exact recipe (rounded-full track, `motion-safe:` width
           *  transition -- spec §3's `.5s ease`) satisfies this migration's "motion behind
           *  prefers-reduced-motion" rule, not the literal component: `ProgressBar` colours its
           *  fill from the `StatusTone` vocabulary, but `project-header.test.tsx` pins the
           *  literal `bg-tone-waiting`/`bg-tone-blocked` class strings used directly here for
           *  this ratio's own three-way threshold (not a status at all). */}
          {/* No bar at all for an unbudgeted workspace: a bar is a fraction of a ceiling, and
           *  an empty track would read as "0% of something" rather than "there is no
           *  something" (M12 Task 9 / ruling R11). */}
          {budgetUsd !== null && (
            <span className="h-[3px] w-[150px] overflow-hidden rounded-[2px] bg-white/[0.08]">
              <span className={`block h-full motion-safe:[transition:width_.5s_ease] ${barColor}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
            </span>
          )}
        </span>
        <EmergencyStopButton key={String(facts.status.haltedReason !== null)} workspaceId={workspaceId} halted={facts.status.haltedReason !== null} />
      </span>
    </header>
  )
}
