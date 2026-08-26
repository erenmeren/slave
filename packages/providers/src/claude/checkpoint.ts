import type { ProviderKind } from '../types.js'

/**
 * The provider-neutral checkpoint shape `resume()` accepts (ADR 0001 §5, M3 design spec §6, plus
 * `settingsPath`/`hookPath`/`gitAuthorName`/`gitAuthorEmail` -- fix round 1's ruling below).
 *
 * `packages/db`'s `Checkpoint` Prisma model carries the same fifteen fields below, plus
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
 *
 * **Fix round 1 -- `settingsPath`, `hookPath`, `gitAuthorName`, `gitAuthorEmail` were added here
 * after Task 9 shipped without them.** The original implementation had `resume()` recover these
 * from `this.mustGetRun(runId).startInput` -- the *same adapter instance's* memory of the
 * `StartRunInput` it spawned the run with the first time. That works only while the process that
 * called `start()` is still alive, which makes a "checkpoint" that cannot actually survive what a
 * checkpoint exists to survive (ADR 0001 §5 puts `worktreePath` here for exactly this reason: "a
 * fresh process must be able to resume a run it never started"). These four are the same *kind*
 * of fact `worktreePath` is -- things the resumed spawn needs and the CLI cannot rediscover from
 * `--resume <sessionId>` alone -- so they belong in the same place, even though ADR 0001 §5's
 * original table does not name them: that table was derived from what the CLI needs to resume,
 * not from what this specific adapter's spawn needs, and this ruling completes the list rather
 * than contradicting it. `gitIdentity` is flattened to two scalar fields here rather than kept as
 * a nested `{ name, email }` object -- deliberately, unlike `StartRunInput.gitIdentity`, which
 * keeps its nested shape: the pinning test writes this shape straight through Prisma, and a
 * nested object has no column to land in.
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
  /**
   * The run's original `--settings` file, absolute. A resumed process needs the same permission
   * posture the paused one had -- `--resume <sessionId>` alone tells the CLI which session to
   * continue, not which settings file governed it, and there is nowhere else a fresh process
   * (one that never called this run's `start()`) could recover this from.
   */
  readonly settingsPath: string
  /**
   * The `PreToolUse` hook script `settingsPath` registers, absolute. Not read directly by the
   * resumed spawn itself, but a fresh process re-deriving a `StartRunInput` for `resume()` has no
   * other source for it -- the same "the CLI cannot rediscover this" reasoning as `settingsPath`.
   */
  readonly hookPath: string
  /**
   * Git identity for the resumed process's commits (`GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME`,
   * ADR 0001 "Concurrency and the git common directory"). A fresh process has no `git config` to
   * fall back on -- identity is supplied per-process by design, precisely so it cannot leak from
   * or be recovered out of shared repo state -- so the checkpoint is the only place left to carry
   * it across a process boundary the original `start()` call did not survive.
   */
  readonly gitAuthorName: string
  readonly gitAuthorEmail: string
  /**
   * The model the run started with (M10 §6), resolved once at spawn time by
   * `resolveRuntime` (M12 Task 8; defined in `packages/control/src/runtime.ts` since Task 9,
   * re-exported from `apps/orchestrator/src/model.ts`) and never re-resolved on resume -- a resumed
   * run must continue with the SAME model it started with, never whatever an operator's
   * `setAgentModel` set most recently, so a mid-run model change affects only the run's NEXT
   * dispatch. Optional, not `string | null`: a legacy checkpoint written before this field existed
   * carries no value at all rather than an explicit null, and `resume()` treats both the same way
   * -- no `--model` flag is appended.
   */
  readonly model?: string
  /**
   * The provider the run started with (M12 Task 6), beside `model` for the same reason --
   * mirrored on `packages/db`'s `Checkpoint` model rather than imported, per this docstring's
   * duplication ruling above. Optional, not `ProviderKind | null`, for the same reason `model` is:
   * a checkpoint written before this field existed carries no value at all.
   */
  readonly provider?: ProviderKind
}
