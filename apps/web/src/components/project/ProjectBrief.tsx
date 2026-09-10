'use client'

import Link from 'next/link'
import { SUPERVISOR_PER_CALL_CAP_USD, USER_CARD_LABEL, type UserCardState } from '@slave-of-ai/domain'
import type { ProjectBrief as ProjectBriefFacts } from '../../server/brief'
import type { NeedsYouItem } from '../../server/needsYou'
import { CARD_STATE_TONE } from '../../lib/tones'
import { AvatarTile } from '../ui/AvatarTile'
import { Chip } from '../ui/Chip'
import { EmptyState } from '../ui/EmptyState'
import { Panel } from '../ui/Panel'
import { SectionLabel } from '../ui/SectionLabel'
import { TONE_BORDER, TONE_FILL, TONE_TEXT, type StatusTone } from '../ui/StatusPill'

/** The word each needs-you kind is announced with. The domain's `NeedsYouItem['kind']` is a raw
 *  member and never visible text (`docs/ia.md` rule 3); this is the reading of it. */
const NEEDS_YOU_WORD: Readonly<Record<NeedsYouItem['kind'], string>> = {
  blocked_task: 'BLOCKED',
  decision: 'DECISION',
  question: 'QUESTION',
  integrate: 'READY TO INTEGRATE',
}

/** The tone each needs-you kind is painted in. A blocked task and a question are two different
 *  problems; only one of them is red. */
const NEEDS_YOU_TONE: Readonly<Record<NeedsYouItem['kind'], StatusTone>> = {
  blocked_task: 'blocked',
  decision: 'waiting',
  question: 'waiting',
  integrate: 'review',
}

/** What each kind of "verified" actually means, said out loud rather than left as a member. */
const VERIFIED_WORD: Readonly<Record<NonNullable<ProjectBriefFacts['latestVerified']>['kind'], string>> = {
  integrated: 'integrated into the base branch',
  approved: 'approved in review',
  verified: 'passed its verify commands',
}

/** The five work words, in the order a person reads a pipeline. The KEY is the field on
 *  `brief.work`; the WORD is what the domain calls that state to a person. */
const WORK_WORDS: readonly { readonly key: keyof ProjectBriefFacts['work']; readonly word: string }[] = [
  { key: 'working', word: 'WORKING' },
  { key: 'verifying', word: 'VERIFYING' },
  { key: 'review', word: 'IN REVIEW' },
  { key: 'waiting', word: 'WAITING' },
  { key: 'done', word: 'DONE' },
]

/**
 * The tone behind a worker's projected status WORD.
 *
 * `brief.team[].status` is `userSlaveStatus(...).label` -- the word, deliberately, because a raw
 * `pause_requested` must never reach the wire as the thing a page renders. That leaves this
 * component with a label and no state, so it reads the domain's own `USER_CARD_LABEL` BACKWARDS to
 * recover the state and asks `CARD_STATE_TONE` for the colour. One table, inverted, rather than a
 * second word->colour map to drift: a label the domain does not know falls back to the muted
 * `idle` tone rather than throwing on a row.
 */
function toneForCardLabel(label: string): StatusTone {
  const state = (Object.keys(USER_CARD_LABEL) as UserCardState[]).find((one) => USER_CARD_LABEL[one] === label)
  return CARD_STATE_TONE[state ?? 'idle'].tone
}

/** `HH:MM:SS` out of an ISO stamp, the way `LiveEventsPanel` does it -- a "3 minutes ago" computed
 *  against now would be wrong the moment this page stopped refreshing. */
function clock(iso: string): string {
  return iso.slice(11, 19)
}

/** One tile. A `Panel` with the fact's caption above it, marked so the gate and Tasks 4-5 can name
 *  each of the eight by the fact it carries rather than by its position. */
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
    <div data-testid="brief-tile" data-brief={fact} className="min-w-0">
      <Panel>
        <SectionLabel>{caption}</SectionLabel>
        {children}
      </Panel>
    </div>
  )
}

/**
 * The eight facts (M45 R1), in two rows of four.
 *
 * The `work` tile and the `strip` below it on the page BOTH count this project's tasks, and that
 * is deliberate (M45 plan erratum E17). They are not the same statement: this tile speaks the
 * domain's user vocabulary (`userTaskStatus` -- WORKING / VERIFYING / IN REVIEW / WAITING / DONE),
 * which is what a person reads in ten seconds; `TopStrip` keeps the raw board counts the design
 * handoff documents and `gate:m14-fidelity` measures. Deleting the strip in a milestone that must
 * not move README pixels was not on the table.
 *
 * PRESENTATIONAL: it fetches nothing and holds no state. Every string it renders that a model or a
 * person wrote (`objective.text`, `needsYou[].title`, `recentChanges[].summary`) goes in as JSX
 * children -- another party's text is data, never elements (spec §1).
 */
export function ProjectBrief({
  workspaceId,
  brief,
  onOpenSlave,
}: {
  readonly workspaceId: string
  readonly brief: ProjectBriefFacts
  /** OPTIONAL. `OverviewClient` passes `?slave=`'s setter; a brief rendered without one still has
   *  to be a correct brief, so a row with nowhere to go is a plain row rather than a dead button. */
  readonly onOpenSlave?: (slaveId: string) => void
}): React.JSX.Element {
  const { objective, supervisor, work, cost, needsYou, latestVerified, team, recentChanges } = brief
  const supervisorTone: StatusTone = supervisor.needsYou ? 'blocked' : supervisor.state === 'working' ? 'working' : 'idle'

  return (
    <div
      data-testid="brief"
      className="grid grid-cols-1 gap-[11px] px-[20px] pt-[16px] md:grid-cols-2 xl:grid-cols-4"
    >
      <Tile fact="objective" caption="objective">
        {objective.text === null ? (
          <Link href={`/w/${workspaceId}/settings`} className="text-xs text-text-2 underline">
            no objective yet · set one
          </Link>
        ) : (
          <>
            {/* The whole text in `title`, three lines on screen: a goal document is paragraphs
              * long and this tile is one of eight. */}
            <span title={objective.text} className="line-clamp-3 text-xs text-text-1">
              {objective.text}
            </span>
            <div className="flex items-center gap-2">
              <Chip>v{objective.version}</Chip>
              <Link href={`/w/${workspaceId}/settings`} className="text-[11px] text-text-2 underline">
                edit →
              </Link>
            </div>
          </>
        )}
      </Tile>

      <Tile fact="supervisor" caption="supervisor">
        {/* The WORD, with the raw state one hover away -- `docs/ia.md` rule 3. The label is the
          * domain's own (`userSupervisorStatus`), count and all, never assembled here. */}
        <span
          data-testid="brief-supervisor-state"
          title={supervisor.state}
          className={`inline-flex w-fit items-center rounded-pill border px-[7px] py-[3px] font-mono text-[9.5px] uppercase tracking-wide ${TONE_FILL[supervisorTone]} ${TONE_BORDER[supervisorTone]} ${TONE_TEXT[supervisorTone]}`}
        >
          {supervisor.label}
        </span>
      </Tile>

      <Tile fact="work" caption="work">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
          {WORK_WORDS.map(({ key, word }) => (
            <span
              key={key}
              data-testid={`brief-work-${key}`}
              // A zero is DIMMED, never hidden: a person asking "is anything being reviewed"
              // needs to read the 0.
              className={work[key] === 0 ? 'text-text-3' : 'text-text-1'}
            >
              {word} {work[key]}
            </span>
          ))}
        </div>
      </Tile>

      <Tile fact="cost" caption="cost">
        <span className="font-mono text-[15px] text-text-1">
          {cost.budgetUsd === null ? `$${cost.spentUsd.toFixed(2)}` : `$${cost.spentUsd.toFixed(2)} / $${String(cost.budgetUsd)}`}
        </span>
        {/* The M32 upper-bound policy, in three sentences that are three different facts and never
          * one number pretending to be all three: what somebody reported, what was charged at the
          * cap because nothing came back, and what nobody can account for at all. */}
        <span className="text-[11px] text-text-2">measured ${cost.measuredUsd.toFixed(2)}</span>
        {cost.unmeasuredCalls > 0 && (
          <span data-testid="brief-cost-unmeasured-calls" className="text-[11px] text-tone-waiting">
            {cost.unmeasuredCalls} unmeasured calls charged at ${SUPERVISOR_PER_CALL_CAP_USD.toFixed(2)} each
          </span>
        )}
        {cost.unmeasuredRuns > 0 && (
          <span data-testid="brief-cost-unmeasured-runs" className="text-[11px] text-tone-waiting">
            {cost.unmeasuredRuns} unmeasured runs (not in the total)
          </span>
        )}
      </Tile>

      <Tile fact="needs-you" caption="needs you">
        {needsYou.length === 0 ? (
          <EmptyState testId="needs-you-empty" message="nothing needs you" />
        ) : (
          <ul className="flex flex-col gap-1">
            {needsYou.map((item) => (
              <li key={`${item.kind}-${item.id}`} data-testid="needs-you-row" className="flex items-baseline gap-2 text-xs">
                <Chip tone={NEEDS_YOU_TONE[item.kind]} title={item.kind}>
                  {NEEDS_YOU_WORD[item.kind]}
                </Chip>
                <Link href={item.href} className="min-w-0 flex-1 truncate text-text-1 underline">
                  {item.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Tile>

      <Tile fact="latest-verified" caption="latest verified">
        {latestVerified === null ? (
          <EmptyState testId="latest-verified-empty" message="nothing verified yet" />
        ) : (
          <>
            <span className="text-xs text-text-1">
              {latestVerified.taskTitle} — {VERIFIED_WORD[latestVerified.kind]}
            </span>
            <span className="font-mono text-[10px] text-text-3">{clock(latestVerified.at)}</span>
          </>
        )}
      </Tile>

      <Tile fact="team" caption="team">
        {team.length === 0 ? (
          <EmptyState testId="brief-team-empty" message="nobody works here yet" />
        ) : (
          <ul className="flex flex-col gap-1">
            {team.map((member) => {
              const tone = toneForCardLabel(member.status)
              const body = (
                <>
                  <AvatarTile name={member.name} tone={tone} />
                  <span className="shrink-0 text-xs text-text-1">{member.name}</span>
                  <span className="shrink-0 text-[11px] text-text-3">{member.roleLabel}</span>
                  <span className={`shrink-0 font-mono text-[9.5px] uppercase ${TONE_TEXT[tone]}`}>{member.status}</span>
                  {member.company && (
                    <span data-testid="team-company" className="shrink-0 rounded-chip border border-line px-1.5 text-[9.5px] text-text-3">
                      company
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[11px] text-text-2">{member.taskTitle ?? '—'}</span>
                </>
              )
              return (
                <li key={member.slaveId}>
                  {onOpenSlave === undefined ? (
                    <div data-testid="team-row" className="flex w-full items-center gap-2 text-left">
                      {body}
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="team-row"
                      onClick={() => onOpenSlave(member.slaveId)}
                      className="flex w-full items-center gap-2 rounded-nav text-left hover:bg-white/[0.045]"
                    >
                      {body}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Tile>

      <Tile fact="recent-changes" caption="recent changes">
        {recentChanges.length === 0 ? (
          <EmptyState testId="recent-changes-empty" message="nothing has changed yet" />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {recentChanges.map((change) => (
              <li key={`${change.at}-${change.summary}`} className="flex items-baseline gap-2 font-mono text-[10.5px] text-text-2">
                <span className="shrink-0 text-text-3">{clock(change.at)}</span>
                <span className="min-w-0 truncate">{change.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </Tile>
    </div>
  )
}
