'use client'

import Link from 'next/link'
import { SUPERVISOR_PER_CALL_CAP_USD } from '@slave-of-ai/domain'
import type { ProjectBrief as ProjectBriefFacts } from '../../server/brief'
import { formatUsd } from '../../lib/realMoney'
import { EmptyState } from '../ui/EmptyState'
import { StatusPill, type StatusTone } from '../ui/StatusPill'

/** What each kind of "verified" actually means, said out loud rather than left as a member. */
const VERIFIED_WORD: Readonly<Record<NonNullable<ProjectBriefFacts['latestVerified']>['kind'], string>> = {
  integrated: 'integrated into the base branch',
  approved: 'approved in review',
  verified: 'passed its verify commands',
}

/**
 * FIVE keys and FIVE distinct fills (M57 R17, ruling P23).
 *
 * The keys are the READ MODEL's (`ProjectBriefFacts['work']`), not the README's -- the README draws
 * `working / planning / review / blocked / done` and `server/brief.ts` counts
 * `working / verifying / review / waiting / done`. Changing the buckets is a read-model change and
 * a `gate:m45` change, which is a different milestone's work.
 *
 * What this milestone does owe the README is FIVE segments a person can tell apart: `verifying`
 * takes `--s-planning`, which is the tone nothing else in this bar uses. Every fill is a LITERAL
 * class string because Tailwind's static scan cannot see an interpolated tone -- the rule
 * `ui/StatusPill.tsx`'s `TONE_*` maps document.
 */
const WORK_WORDS: readonly { readonly key: keyof ProjectBriefFacts['work']; readonly word: string; readonly fill: string }[] = [
  { key: 'working', word: 'WORKING', fill: 'bg-s-working' },
  { key: 'verifying', word: 'VERIFYING', fill: 'bg-s-planning' },
  { key: 'review', word: 'IN REVIEW', fill: 'bg-s-review' },
  { key: 'waiting', word: 'WAITING', fill: 'bg-s-waiting' },
  { key: 'done', word: 'DONE', fill: 'bg-s-done' },
]

/** `HH:MM:SS` out of an ISO stamp, the way the live-events panel does it -- a "3 minutes ago"
 *  computed against now would be wrong the moment this page stopped refreshing. */
function clock(iso: string): string {
  return iso.slice(11, 19)
}

/** One tile: the README's card recipe with the fact's caption above it, marked so the gates and
 *  Tasks 7-9 can name each of the four by the fact it carries rather than by its position. */
function Tile({
  fact,
  caption,
  children,
}: {
  readonly fact: string
  readonly caption: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="brief-tile"
      data-brief={fact}
      className="flex min-w-0 flex-col rounded-panel-card border border-line bg-card px-4 py-[14px] shadow-card"
    >
      {/* README "Overview": caption 12px `--t3`, then the fact. Not `SectionLabel` -- that is a
        * 9px mono uppercase rail label, and these are sentence-case captions. */}
      <div className="mb-[6px] text-[12px] text-t3">{caption}</div>
      {children}
    </div>
  )
}

/**
 * The four fact tiles (M57 R17), in the README's order: work, cost, supervisor, latest verified.
 *
 * The brief used to be EIGHT tiles. Four of them left for the surface each fact belongs on
 * (`docs/ia.md` rule 2 -- moved, not removed): the OBJECTIVE is the page's own title row, where a
 * goal belongs; NEEDS YOU is the Needs-you card above these tiles, which shows all four kinds
 * rather than a five-row slice and answers a decision in place; TEAM is the Team rows below them,
 * which list every worker; RECENT CHANGES is the timeline in the Recent changes section, which is
 * a fuller answer than five mono lines.
 *
 * The container carries BOTH testids on purpose. `brief` is what `gate:m45` waits on; `strip` is
 * what `gate-m14-fidelity`, `gate-m44-ux-foundation` and `gate-m49-memory` wait on as the
 * Overview's structural marker, and it is free now that `TopStrip` is gone. A DOM node may carry
 * one `data-testid`, so the outer element takes `strip` and the tile grid takes `brief`.
 *
 * PRESENTATIONAL: it fetches nothing and holds no state. Every string it renders that a model or a
 * person wrote goes in as JSX children -- another party's text is data, never elements (spec §1).
 */
export function ProjectBrief({
  workspaceId,
  brief,
  runbookLine = null,
}: {
  readonly workspaceId: string
  readonly brief: ProjectBriefFacts
  /** README "Overview" → Supervisor tile: `Runbook <name> · stage n/N <stage>`, or null when this
   *  project has adopted none. It is NOT on `ProjectBrief` the DTO (`server/brief.ts` has no
   *  runbook field) -- `OverviewClient` composes it from `view.runbook`, which `RunbookPanel` below
   *  already reads, so no read model changes. */
  readonly runbookLine?: string | null
}): React.JSX.Element {
  const { supervisor, work, cost, latestVerified, knowledge } = brief
  const supervisorTone: StatusTone = supervisor.needsYou ? 'blocked' : supervisor.state === 'working' ? 'working' : 'idle'
  const workTotal = WORK_WORDS.reduce((n, { key }) => n + work[key], 0)

  return (
    <section data-testid="strip" className="px-[24px] pt-[18px]">
      <div data-testid="brief" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Tile fact="work" caption={`Work · ${String(workTotal)} tasks`}>
          {/* README: an 8px segmented bar, 2px gaps, one segment per word, in the word's own tone. */}
          <div className="flex h-2 gap-[2px] overflow-hidden rounded-hair">
            {WORK_WORDS.map(({ key, fill }) => (
              <span
                key={key}
                className={`block h-full ${fill}`}
                style={{ width: `${String(workTotal === 0 ? 0 : (work[key] / workTotal) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-[10px] flex flex-wrap gap-x-[10px] gap-y-1 text-[12.5px] text-t2">
            {WORK_WORDS.map(({ key, word }) => (
              // A zero is DIMMED, never hidden: a person asking "is anything being reviewed" needs
              // to read the 0. The testid and the word are unchanged from the eight-tile brief, so
              // `gate:m45`'s `['work','WORKING']` and `['work','IN REVIEW']` pairs still match.
              <span key={key} data-testid={`brief-work-${key}`} className={work[key] === 0 ? 'text-t3' : 'text-t2'}>
                <b className={work[key] === 0 ? 'font-medium text-t3' : 'font-medium text-t1'}>{work[key]}</b> {word}
              </span>
            ))}
          </div>
        </Tile>

        <Tile fact="cost" caption="Cost">
          {/* README: 22px mono, -.5px. The five lines below are M32/M51's and are NOT touched --
            * `gate:m51-breaker` reads four of them out of this exact tile, by
            * `[data-testid="brief-tile"][data-brief="cost"]`, and needs no edit at all. */}
          <span className="font-mono text-[22px] font-semibold tracking-[-.5px] text-t1">
            {cost.budgetUsd === null ? formatUsd(cost.spentUsd) : `${formatUsd(cost.spentUsd)} / $${String(cost.budgetUsd)}`}
          </span>
          <span data-testid="brief-cost-actual" className="mt-1 text-[12.5px] text-t2">
            actual {formatUsd(cost.actualUsd)}
          </span>
          {formatUsd(cost.estimatedUsd) !== formatUsd(cost.actualUsd) && (
            <span data-testid="brief-cost-estimated" className="text-[12.5px] text-t2">
              estimated {formatUsd(cost.estimatedUsd)}
            </span>
          )}
          {formatUsd(cost.upperBoundUsd) !== formatUsd(cost.spentUsd) && (
            <span data-testid="brief-cost-upper-bound" className="text-[12.5px] text-s-waiting">
              upper bound {formatUsd(cost.upperBoundUsd)}
            </span>
          )}
          {cost.unmeasuredCalls > 0 && (
            <span data-testid="brief-cost-unmeasured-calls" className="text-[12.5px] text-s-waiting">
              {cost.unmeasuredCalls} unmeasured calls charged at {formatUsd(SUPERVISOR_PER_CALL_CAP_USD)} each
            </span>
          )}
          {cost.unmeasuredRuns > 0 && (
            <span data-testid="brief-cost-unmeasured-runs" className="text-[12.5px] text-s-waiting">
              {cost.unmeasuredRuns} unmeasured runs (not in the total)
            </span>
          )}
        </Tile>

        <Tile fact="supervisor" caption="Supervisor">
          {/* Unchanged from the eight-tile brief, deliberately: `gate:m45` reads this node's text
            * AND its `title`, and asserts the word is "1 DECISION WAITING" with the raw state
            * "decisions" behind it (`docs/ia.md` rule 3). Not one character moves. */}
          <span data-testid="brief-supervisor-state" title={supervisor.state} className="w-fit">
            <StatusPill tone={supervisorTone} label={supervisor.label} />
          </span>
          {/* README: "Runbook <b>Web feature</b> · stage 3/5 Verify". ONE line, from the snapshot
            * the page already holds; `RunbookPanel` keeps its own section below, with its own
            * eleven testids that `gate:m48-runbooks` reads. */}
          {runbookLine !== null && (
            <span data-testid="brief-runbook-line" className="mt-2 text-[12.5px] text-t2">
              {runbookLine}
            </span>
          )}
        </Tile>

        <Tile fact="latest-verified" caption="Latest verified">
          {latestVerified === null ? (
            <EmptyState testId="latest-verified-empty" message="nothing verified yet" />
          ) : (
            <>
              {/* `gate:m45` asserts this tile says the task's title and the word "integrated". */}
              <span className="font-medium text-t1">
                {latestVerified.taskTitle} — {VERIFIED_WORD[latestVerified.kind]}
              </span>
              <span className="font-mono text-[12px] text-t3">{clock(latestVerified.at)}</span>
            </>
          )}
          {/* M49 R6: what this project knows, beside the last thing it proved -- one line, inside
            * an existing fact, because the brief is a fixed set of tiles and `gate:m45` says so. */}
          <Link
            href={`/w/${workspaceId}/knowledge`}
            data-testid="brief-knowledge"
            className="mt-[6px] text-[12.5px] font-medium text-accent"
          >
            Knowledge: {knowledge.verified} verified · {knowledge.candidates} candidates
          </Link>
        </Tile>
      </div>
    </section>
  )
}
