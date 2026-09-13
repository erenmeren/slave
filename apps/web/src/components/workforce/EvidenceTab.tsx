'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { BESPOKE_PROFILE_LABEL, COST_PROVENANCE_WORD, INSUFFICIENT_EVIDENCE, domainLabel } from '@slave-of-ai/domain'
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
 * conclusion somebody actually reached settles one. A rate whose denominator is ZERO is therefore
 * not a thin sample at all: it is a question nobody has answered, and the two are DIFFERENT FACTS.
 *
 * Fix round 1, item 4: this is the VISIBLE word for that case now, not a `title` a reader has to
 * hover to find. `Insufficient evidence` means what R11 minted it to mean and nothing else -- "there
 * is a sample and it is too thin to claim a rate from" -- and a column nobody has judged says so.
 */
const NOT_JUDGED_YET = 'not judged yet'

/** The house mark for a measurement nobody took (M16: null is unmeasured, 0 is a measurement), with
 *  the WORD behind it for a screen reader and for a hover -- `SlavePanel`'s `permission-mode-word`
 *  idiom (M52 T5), because a glyph on its own has no accessible name at all. */
const NOT_RECORDED = 'not recorded'

/** The sentence under an empty table when NOTHING has been recorded anywhere. */
const NO_RECORD_AT_ALL = 'no run has left a record yet. A record is written when a run concludes, never before.'

/** One rate, or the words (M53 R11). The BAR renders only when the rate does: `ProgressBar` with a
 *  null `pct` draws a track carrying no `aria-valuenow`, and a greyed empty bar beside the words is
 *  exactly the "greyed percentage" R11 rejected. `gate:m16-chrome`'s check 5 moved onto this pair
 *  (plan erratum E11) -- a shown rate has a bar with a value, a thin one has neither.
 *
 * TWO refusals and not one (fix round 1, item 4): a denominator of ZERO says {@link NOT_JUDGED_YET},
 * because nobody has reached a verdict on any of these runs; a denominator that exists and is under
 * the floor says {@link INSUFFICIENT_EVIDENCE}, with how many have been judged in its `title`.
 *
 * `testId` is passed by the ROW and only when the row states NO rate at all, so the marker appears
 * ONCE rather than once per withheld rate: `getByTestId` would refuse three of them, and the moved
 * check reads the marker as "this row claims nothing". */
function RateCell({ rate, testId }: { readonly rate: EvidenceRate; readonly testId?: string }): React.JSX.Element {
  if (rate.pct === null) {
    return (
      <span
        {...(testId === undefined ? {} : { 'data-testid': testId })}
        {...(rate.judged === 0 ? {} : { title: `${String(rate.judged)} judged so far` })}
        className="text-[11px] text-text-3"
      >
        {rate.judged === 0 ? NOT_JUDGED_YET : INSUFFICIENT_EVIDENCE}
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
      {nothing && <Unrecorded testId="evidence-cost-unrecorded" />}
    </span>
  )
}

/** A median a person reads, or the house mark for one nobody could measure (M16: null is unmeasured,
 *  0 is a measurement) -- the mark with a WORD behind it, never the glyph alone. */
function DurationCell({ ms }: { readonly ms: number | null }): React.JSX.Element {
  if (ms === null) return <Unrecorded testId="evidence-duration-unrecorded" />
  return <span className="font-mono text-[11px] text-text-2">{formatDuration(ms)}</span>
}

/**
 * The `—` mark, with the word a screen reader hears and a hover shows (fix round 1, item 3).
 *
 * `SlavePanel`'s `permission-mode-word` (M52 T5) is the idiom: the glyph is `aria-hidden`, because a
 * dash read aloud is noise, and an `sr-only` word carries the meaning -- otherwise every unmeasured
 * cell on this page has no accessible name at all and the two columns that use the mark are
 * indistinguishable from empty. `title` puts the same word one hover from a sighted reader, which is
 * what the withheld-rate cell beside it already does.
 */
function Unrecorded({ testId }: { readonly testId: string }): React.JSX.Element {
  return (
    <span data-testid={testId} title={NOT_RECORDED} className="font-mono text-[11px] text-text-3">
      <span aria-hidden>—</span>
      <span className="sr-only">{NOT_RECORDED}</span>
    </span>
  )
}

/**
 * "There is nothing here", said ONCE for both tables (fix round 1, finding 2).
 *
 * Under a domain chip the empty table means "nothing in THIS domain", and saying "no run has left a
 * record yet" there is a claim about the whole installation that the page cannot support -- the same
 * class of over-claim as the raw `SUM(costUsd)` tile this milestone deleted. The chip row is read
 * from the taxonomy and most of its chips are empty on a small installation, so clicking one is the
 * ORDINARY way to land here, not an edge.
 *
 * The LABEL and never the key (`docs/ia.md` rule 3), and one function rather than a sentence written
 * twice.
 */
function EvidenceEmpty({ testId, domain }: { readonly testId: string; readonly domain: string | null }): React.JSX.Element {
  return (
    <EmptyState testId={testId} message={domain === null ? NO_RECORD_AT_ALL : `No record in ${domain} yet.`} />
  )
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
  /** The selected domain in WORDS (`docs/ia.md` rule 3), for the empty state that names the filter.
   *  Off the chip list the page was built with; `domainLabel` covers a `?domain=` naming something
   *  the taxonomy does not hold, which is a filter that matches nothing and must still say which. */
  const currentLabel = current === null ? null : (page.domains.find((one) => one.domain === current)?.label ?? domainLabel(current))

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
            <EvidenceEmpty testId="evidence-profile-empty" domain={currentLabel} />
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
            <EvidenceEmpty testId="evidence-model-empty" domain={currentLabel} />
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
  const marker = markerFor(row, row.profileKey)
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
        <DurationCell ms={row.medianDurationMs} />
        <CostCell reportedUsd={row.reportedUsd} estimatedUsd={row.estimatedUsd} unmeasuredRuns={row.unmeasuredRuns} />
      </Row>
    </div>
  )
}

function ModelRow({ row, last }: { readonly row: EvidenceModelRow; readonly last: boolean }): React.JSX.Element {
  const marker = markerFor(row, row.model ?? '')
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
        <DurationCell ms={row.medianDurationMs} />
        <CostCell reportedUsd={row.reportedUsd} estimatedUsd={row.estimatedUsd} unmeasuredRuns={row.unmeasuredRuns} />
      </Row>
    </div>
  )
}

/**
 * The ONE marker a row that claims no rate carries, on its first withheld cell (fix round 1,
 * finding 1).
 *
 * Two of them, because two different facts put a row here and only one of them is R11's:
 *
 * - `evidence-insufficient-<key>` -- the ROW is below `EVIDENCE_MIN_SAMPLE`. Every rate is withheld
 *   by construction, since a judged count can never exceed the attempted count.
 * - `evidence-unjudged-<key>` -- the row has attempts enough and states no rate anyway, because no
 *   denominator it has is one a rate can be claimed from. Task 3's fix round made this ORDINARY:
 *   only a conclusion somebody actually reached settles a judgement column, so a profile with eight
 *   runs and nobody's verdict on any of them is an everyday row, not an exotic one.
 *
 * Both mean the same thing to `gate:m16-chrome`'s moved check 5 -- "this row draws no progress bar"
 * -- and the check partitions on either. Before this round only the first existed, so an unjudged
 * row was classified as CLAIMING rates and then failed for drawing none: vacuous on a seeded
 * database, and a false failure on the first database that has rows.
 *
 * A row carrying NEITHER marker states at least one rate, and therefore draws at least one bar --
 * which is exactly what makes the check's other branch (`bars === valued && valued > 0`) safe.
 */
function markerFor(
  row: { readonly insufficient: boolean; readonly firstPass: EvidenceRate; readonly reviewRejected: EvidenceRate; readonly integrated: EvidenceRate },
  key: string,
): string | undefined {
  if (row.insufficient) return `evidence-insufficient-${key}`
  const claimsNothing = row.firstPass.pct === null && row.reviewRejected.pct === null && row.integrated.pct === null
  return claimsNothing ? `evidence-unjudged-${key}` : undefined
}
