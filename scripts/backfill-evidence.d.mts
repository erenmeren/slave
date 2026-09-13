// The types `scripts/backfill-evidence.mjs` is imported WITH.
//
// `packages/control/test/integration/backfill.test.ts` drives the script's body as a function
// (plan decision D28) and `npm run typecheck` compiles that file, so the one `.mjs` this milestone
// owns needs a declaration the way every `.ts` module in the tree gets one from `tsc`. It is here
// and not inferred because `allowJs` is off everywhere: a `.mjs` with no `.d.mts` beside it is
// `Cannot find module`, and turning `allowJs` on to avoid eight lines would change how every
// package in this repository is compiled.
import type { ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'

/**
 * What one pass did, counted apart.
 *
 * `recorded` is `created + alreadyPresent`: both were re-derived and written, because there is no
 * skip branch (plan erratum E15). `skipped` is `skippedSimulation + skippedIncomplete`: the boundary
 * refusal (`run_not_found`, R13) and every other reason a row could not be recorded.
 *
 * The three `skipped*` figures are **`null` under `--dry-run`** and never `0`: a dry run hands no
 * run to the writer, so nobody measured what it would refuse, and a zero would be a claim.
 *
 * `alreadyJudged` is a READING, never a write (erratum E23): the rows that already carried a verdict
 * when this pass found them, settled by the live pipeline. This script settles nothing — a
 * backfilled run's verify, review and integration columns stay "not judged yet".
 *
 * `skippedNeverStarted` is a NUMBER in both modes (erratum E25): a run with no `run.started` event
 * never ran, so it has no fact here and none in the pipeline either, and deciding that is a read a
 * dry run really makes.
 */
export interface BackfillReport {
  readonly dryRun: boolean
  readonly scanned: number
  readonly recorded: number
  readonly created: number
  readonly alreadyPresent: number
  readonly alreadyJudged: number
  readonly skipped: number | null
  readonly skippedSimulation: number | null
  readonly skippedIncomplete: number | null
  readonly skippedNeverStarted: number
}

export interface BackfillOptions {
  /** Rows per query. The walk is a cursor on the primary key, so this changes how often the
   *  database is asked and never what the pass records. */
  readonly batchSize?: number
  /** Decide everything, write nothing, and name by id every run it would create. */
  readonly dryRun?: boolean
  /** The writer. Defaults to control's `recordRunEvidence` -- the SAME verb the pipeline calls,
   *  which is what makes a backfilled row byte-identical to a live one. A seam for the test. */
  readonly recordOne?: (runId: string) => Promise<Result<void, ControlRefusal>>
}

export declare function backfillEvidence(options?: BackfillOptions): Promise<BackfillReport>
