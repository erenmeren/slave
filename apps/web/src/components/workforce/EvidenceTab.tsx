'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { BESPOKE_PROFILE_LABEL, COST_PROVENANCE_WORD, INSUFFICIENT_EVIDENCE } from '@slave-of-ai/domain'
import type { EvidenceModelRow, EvidencePage, EvidenceProfileRow, EvidenceRate } from '../../server/evidence'
import { formatDuration } from '../../lib/format'
import { formatUsd } from '../../lib/realMoney'
import { Chip } from '../ui/Chip'
import { DataTable, Row } from '../ui/DataTable'
import { EmptyState } from '../ui/EmptyState'
import { Panel } from '../ui/Panel'
import { ProgressBar } from '../ui/ProgressBar'
import { SectionLabel } from '../ui/SectionLabel'

const PROFILE_COLUMNS = '1.5fr 1.1fr 70px 132px 132px 64px 132px 78px 74px 86px 104px'
const PROFILE_HEADER = [
  'Profile',
  'Repository',
  'Attempted',
  'Verified first pass',
  'Review rejected',
  'Rework cycles',
  'Integrated',
  'Interventions',
  'Recoveries',
  'Median duration',
  'Cost',
] as const

const MODEL_COLUMNS = '1.5fr 70px 132px 132px 132px 86px 104px'
const MODEL_HEADER = ['Model', 'Attempted', 'Verified first pass', 'Review rejected', 'Integrated', 'Median duration', 'Cost'] as const

/**
 * "Nobody has reached a verdict on any of these yet" (R3, and Task 3's fix round).
 *
 * A judgement column is nullable on purpose and a null is NEVER read as a `false` -- only a
 * conclusion somebody actually reached settles one. A rate whose denominator is zero is therefore
 * not a thin sample but an unasked question, and the two are said apart in the cell's `title`: the
 * visible words stay `Insufficient evidence` either way, because the page is refusing to state a
 * rate in both cases and a second phrase in the column would be a second thing to read at a glance.
 */
const NOT_JUDGED_YET = 'not judged yet'

/** One rate, or the words (M53 R11). The BAR renders only when the rate does: `ProgressBar` with a
 *  null `pct` draws a track carrying no `aria-valuenow`, and a greyed empty bar beside the words is
 *  exactly the "greyed percentage" R11 rejected. `gate:m16-chrome`'s check 5 moved onto this pair
 *  (plan erratum E11) -- a shown rate has a bar with a value, a thin one has neither.
 *
 * `testId` is passed by the ROW and only when the whole row is below the floor, so
 * `evidence-insufficient-<key>` marks a row ONCE rather than once per withheld rate: `getByTestId`
 * would refuse three of them, and the moved check reads the marker as "this row claims nothing". */
function RateCell({ rate, testId }: { readonly rate: EvidenceRate; readonly testId?: string }): React.JSX.Element {
  if (rate.pct === null) {
    return (
      <span
        {...(testId === undefined ? {} : { 'data-testid': testId })}
        title={rate.judged === 0 ? NOT_JUDGED_YET : `${String(rate.judged)} judged so far`}
        className="text-[11px] text-text-3"
      >
        {INSUFFICIENT_EVIDENCE}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1">
      <span className="w-[34px]">
        <ProgressBar pct={rate.pct} />
      </span>
      <span className="font-mono text-[11px] text-text-2">{`${String(rate.pct)}%`}</span>
      <span className="font-mono text-[9.5px] text-text-3">{`of ${String(rate.judged)}`}</span>
    </span>
  )
}

/** R6 and `docs/ia.md` rule 4: three numbers with three words beside them, and the unmeasured count
 *  on its own line -- never one figure that silently absorbs the runs nobody measured, which is the
 *  raw `SUM(costUsd)` this tab replaces. `formatUsd` is the one real-money formatter; `formatMinor`
 *  is simulated money and is not imported here.
 *
 *  A null figure is not printed at all rather than printed as `— reported`: nothing was reported, so
 *  there is no reported figure to put a word beside. When all three are absent the cell says `—`,
 *  the house mark for a measurement nobody took. */
function CostCell(props: {
  readonly reportedUsd: number | null
  readonly estimatedUsd: number | null
  readonly unmeasuredRuns: number
}): React.JSX.Element {
  const nothing = props.reportedUsd === null && props.estimatedUsd === null && props.unmeasuredRuns === 0
  return (
    <span className="flex flex-col text-[11px]">
      {props.reportedUsd !== null && (
        <span className="font-mono text-text-1">{`${formatUsd(props.reportedUsd)} ${COST_PROVENANCE_WORD.reported}`}</span>
      )}
      {props.estimatedUsd !== null && (
        <span className="font-mono text-text-2">{`${formatUsd(props.estimatedUsd)} ${COST_PROVENANCE_WORD.estimated}`}</span>
      )}
      {props.unmeasuredRuns > 0 && (
        <span className="text-text-3">{`${String(props.unmeasuredRuns)} ${COST_PROVENANCE_WORD.unmeasured}`}</span>
      )}
      {nothing && <span className="font-mono text-text-3">—</span>}
    </span>
  )
}

/** A median a person reads, or the house mark for one nobody could measure (M16: null is
 *  unmeasured, 0 is a measurement). */
function duration(ms: number | null): string {
  return ms === null ? '—' : formatDuration(ms)
}

/**
 * The Evidence tab (M53 R12): two tables, because profile performance and model performance are two
 * different questions and one table would keep confusing them.
 *
 * Counts and rates, and NO CHART of any kind -- `BarChart` is deliberately not imported. There is no
 * universal score, no rating and no rank column: the sort is stated in words under the tables (R11)
 * rather than left to be inferred from the order, and every rate the page will not claim is replaced
 * entirely by the words, with its counts still beside it.
 *
 * GLOBAL, with no workspace picker (plan decision D32): `/workforce` is the people page for the whole
 * installation and a record spans every project it holds. `Repository` is the column that tells one
 * checkout's record from another's, which is the question a workspace picker would have answered.
 */
export function EvidenceTab({
  page,
  selected,
}: {
  readonly page: EvidencePage
  /** The domain chip in the URL, read on the SERVER so the tables arrive already filtered. Passed
   *  explicitly only by tests; the default reads the same `?domain=` the page was built from. */
  readonly selected?: string | null
}): React.JSX.Element {
  const router = useRouter()
  const searchParams = useSearchParams()
  const current = selected === undefined ? searchParams.get('domain') : selected

  /**
   * D35: the URL is written with `window.history.replaceState`, MERGED into the current query --
   * `WorkforceClient`'s own rule for `?tab=`, so a link that arrived with `?tab=evidence` keeps it
   * and no history entry is stacked for a Back press to walk through.
   *
   * Then `router.refresh()`, which `?tab=` does not need and this does: a tab switch re-renders a
   * panel this component already has, while a domain changes the DATA -- both tables are aggregates
   * the server read under this filter, and no amount of client work can narrow a `GROUP BY` that has
   * already happened. Next syncs its canonical URL with `replaceState`, so the refresh re-reads the
   * query just written.
   */
  const choose = (domain: string | null): void => {
    const query = new URLSearchParams(searchParams)
    if (domain === null) query.delete('domain')
    else query.set('domain', domain)
    const search = query.toString()
    window.history.replaceState(null, '', search === '' ? '/workforce' : `/workforce?${search}`)
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-4">
      <div data-testid="evidence-domains" className="flex flex-wrap items-center gap-1">
        {/* The way back to every domain, beside the chips rather than hidden in a second click of
          * the selected one: a filter a person cannot undo is a filter they stop using. */}
        <button
          type="button"
          data-testid="evidence-domain-clear"
          data-domain=""
          aria-pressed={current === null}
          onClick={() => choose(null)}
        >
          <Chip {...(current === null ? { tone: 'done' as const } : {})}>All domains</Chip>
        </button>
        {page.domains.map((one) => (
          // The WORD on the chip and the raw key on `data-domain` and in `title`
          // (`docs/ia.md` rule 3) -- which is also what `gate:m53-evidence` stage 10 reads.
          <button
            key={one.domain}
            type="button"
            data-testid={`evidence-domain-${one.domain}`}
            data-domain={one.domain}
            title={one.domain}
            aria-pressed={current === one.domain}
            onClick={() => choose(one.domain)}
          >
            <Chip {...(current === one.domain ? { tone: 'done' as const } : {})}>{one.label}</Chip>
          </button>
        ))}
      </div>

      <Panel title="by profile">
        <div data-testid="evidence-table-profile">
          {page.byProfile.length === 0 ? (
            <EmptyState
              testId="evidence-profile-empty"
              message="no run has left a record yet. A record is written when a run concludes, never before."
            />
          ) : (
            <DataTable columns={PROFILE_COLUMNS} header={[...PROFILE_HEADER]}>
              {page.byProfile.map((row, index) => (
                <ProfileRow key={`${row.profileKey}/${row.repositoryKey}`} row={row} last={index === page.byProfile.length - 1} />
              ))}
            </DataTable>
          )}
        </div>
      </Panel>

      <Panel title="by model">
        <div data-testid="evidence-table-model">
          {page.byModel.length === 0 ? (
            <EmptyState
              testId="evidence-model-empty"
              message="no run has left a record yet. A record is written when a run concludes, never before."
            />
          ) : (
            <DataTable columns={MODEL_COLUMNS} header={[...MODEL_HEADER]}>
              {page.byModel.map((row, index) => (
                <ModelRow key={row.model ?? ''} row={row} last={index === page.byModel.length - 1} />
              ))}
            </DataTable>
          )}
        </div>
      </Panel>

      {/* The sort, in words, under both tables (R11): stated rather than left to be inferred from
        * the order -- and the sentence `gate:m53-evidence` stage 11 checks the order against. */}
      <SectionLabel testId="evidence-sort-caption">{page.sortCaption}</SectionLabel>
    </div>
  )
}

function ProfileRow({ row, last }: { readonly row: EvidenceProfileRow; readonly last: boolean }): React.JSX.Element {
  // The marker goes on the FIRST withheld rate and only when the whole ROW is thin -- see
  // `RateCell`. A row with one thin denominator carries none, which is what keeps the moved
  // `gate:m16-chrome` check 5 reading "claims nothing" rather than "claims some of it".
  const marker = row.insufficient ? `evidence-insufficient-${row.profileKey}` : undefined
  return (
    // The wrapper carries the row's own identity, so the `data-table-row` handle four gates read
    // stays exactly where it is (`WorkforceCatalog`'s idiom, and `OrganizationClient`'s).
    //
    // The testid is the PROFILE key alone, which is this milestone's stated handle -- but the table
    // groups by profile AND repository (D32), so one persona worked on two checkouts is two rows
    // wearing the same testid. `data-repository-key` is what tells them apart for anything that has
    // to address one of them; a gate that walks `[data-testid^="evidence-profile-row-"]` sees both.
    <div
      data-testid={`evidence-profile-row-${row.profileKey}`}
      data-profile-key={row.profileKey}
      data-repository-key={row.repositoryKey}
    >
      <Row columns={PROFILE_COLUMNS} last={last}>
        <span className="flex min-w-0 items-center gap-1.5">
          {/* The NAME, with the key one hover away and on `data-profile-key` above -- never as
            * text (`docs/ia.md` rule 3). */}
          <span title={row.profileKey} className="truncate text-[12.5px] text-text-1">
            {row.name}
          </span>
          {row.bespoke && (
            <Chip testId="evidence-bespoke" title={row.profileKey}>
              {BESPOKE_PROFILE_LABEL}
            </Chip>
          )}
        </span>
        {/* The same persona on two checkouts is two records (D32): folding them would average
          * across codebases, so the repository is a dimension and not a footnote. */}
        <span title={row.repositoryKey} className="truncate font-mono text-[10px] text-text-3">
          {row.repositoryKey}
        </span>
        <span className="font-mono text-[11px] text-text-2">{String(row.attempted)}</span>
        <RateCell rate={row.firstPass} {...(marker === undefined ? {} : { testId: marker })} />
        <RateCell rate={row.reviewRejected} />
        <span className="font-mono text-[11px] text-text-2">{String(row.reworkCycles)}</span>
        <RateCell rate={row.integrated} />
        <span className="font-mono text-[11px] text-text-2">{String(row.humanInterventions)}</span>
        <span className="font-mono text-[11px] text-text-2">{String(row.recoveries)}</span>
        <span className="font-mono text-[11px] text-text-2">{duration(row.medianDurationMs)}</span>
        <CostCell reportedUsd={row.reportedUsd} estimatedUsd={row.estimatedUsd} unmeasuredRuns={row.unmeasuredRuns} />
      </Row>
    </div>
  )
}

function ModelRow({ row, last }: { readonly row: EvidenceModelRow; readonly last: boolean }): React.JSX.Element {
  const marker = row.insufficient ? `evidence-insufficient-${row.model ?? ''}` : undefined
  return (
    <div data-testid={`evidence-model-row-${row.model ?? ''}`} data-model={row.model ?? ''}>
      <Row columns={MODEL_COLUMNS} last={last}>
        {/* A null model is a REAL group -- a run recorded before M51 wrote one -- and it is named in
          * words rather than dropped or printed as a blank. */}
        <span {...(row.model === null ? {} : { title: row.model })} className="truncate text-[12.5px] text-text-1">
          {row.label}
        </span>
        <span className="font-mono text-[11px] text-text-2">{String(row.attempted)}</span>
        <RateCell rate={row.firstPass} {...(marker === undefined ? {} : { testId: marker })} />
        <RateCell rate={row.reviewRejected} />
        <RateCell rate={row.integrated} />
        <span className="font-mono text-[11px] text-text-2">{duration(row.medianDurationMs)}</span>
        <CostCell reportedUsd={row.reportedUsd} estimatedUsd={row.estimatedUsd} unmeasuredRuns={row.unmeasuredRuns} />
      </Row>
    </div>
  )
}
