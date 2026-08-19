/**
 * The provider-neutral checkpoint shape `resume()` accepts (ADR 0001 §5, M3 design spec §6).
 *
 * `packages/db`'s `Checkpoint` Prisma model carries the same eleven fields below, plus
 * provenance columns (`id`, `runId`, `pauseReason`, `requestedBy`, `ts`) that belong to the
 * orchestrator's persistence layer, not to a runtime adapter. The duplication between that model
 * and this interface is deliberate, not an oversight: `packages/providers` may not depend on
 * `packages/db` in `src` -- the adapter translates the CLI's stream into this vocabulary, the
 * orchestrator persists it, and that boundary is the write gate the package split exists to
 * enforce. Importing the Prisma model here to avoid repeating its field list would erase the
 * boundary it is meant to hold.
 *
 * What is not acceptable is letting the two shapes drift apart silently -- a field added to one
 * and not the other would be a silent gap in what a resumed run can recover. See
 * `packages/providers/test/integration/checkpoint-shape.test.ts`, which builds a `Checkpoint` from
 * this interface, writes it through Prisma, reads it back, and asserts every field survives byte
 * for byte. That test is the one place in this package where a *test* importing `packages/db` is
 * correct rather than a violation of the boundary above.
 */
export interface Checkpoint {
  /**
   * Written once at run start, from the first `system/init` line, and never rewritten -- a plain
   * `--resume` reports the same UUID (ADR 0001 §5, findings 2.3, 4.3). `resume()` passes this
   * straight through as `--resume <sessionId>`; it never mints a new one.
   */
  readonly sessionId: string
  /** `resume()` must spawn with cwd set to this, the run's original worktree directory. */
  readonly worktreePath: string
  /**
   * The run's unique `AITEAMOS_PAUSE_FLAG` path. `resume()` must clear it and verify it is
   * absent before spawning, or the hook denies every tool call the resumed run attempts.
   */
  readonly pauseFlagPath: string
  /** The concrete form of "last completed step" -- the stream has no notion of a step. */
  readonly lastToolUseId: string | null
  readonly lastToolName: string | null
  readonly numTurns: number
  /**
   * From the terminal `result` event's `permission_denials`. On resume the model re-attempted
   * exactly these calls, in order -- this is the operator's view of what the agent was about to
   * do (ADR 0001 §5, findings 3.5, 4.5-ii).
   */
  readonly deniedToolUseIds: readonly string[]
  /**
   * `HEAD` alone is insufficient -- the interesting state is usually uncommitted, so
   * `dirtyFiles` (from `git status --porcelain`) is recorded alongside it.
   */
  readonly headCommit: string
  readonly dirtyFiles: readonly string[]
  /** Each run segment reports its own totals (ADR 0001 §5, Q3: per-segment, not cumulative). */
  readonly cumulativeCostUsd: number
  readonly cumulativeTokens: number
}
