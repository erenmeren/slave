import { manifestFor, type ProviderKind, type RunId } from '@slave-of-ai/domain'
import type { Checkpoint } from '../claude/checkpoint.js'
import type { ModelListing } from '../models.js'
import type { RuntimeEvent } from '../types.js'

/**
 * What a runtime can promise. Every member has exactly one consumer in the system --
 * a capability nothing reads is a claim nothing checks, so it does not exist here.
 *
 * Since M56a R4 every member is a PROJECTION of that provider's manifest
 * (`packages/domain/src/provider/manifest.ts`) rather than a hand-written row, and
 * `capabilities.ts` is where the projection is spelled. The rule above is why this interface did
 * NOT grow a member for `structuredOutput`, `usageCost` or `toolVocabulary` when the manifest did:
 * a manifest records what is true about a vendor, and this records what THIS SYSTEM reads.
 */
export interface ProviderCapabilities {
  /** Consumed by the pause strategy: can this runtime stop between tool calls? */
  readonly canPauseMidRun: boolean
  /** Consumed by the pause strategy: can a stopped session be continued? */
  readonly canResumeSession: boolean
  /** Consumed by gate semantics and the roster's provider mark. */
  readonly gate: 'all-tools' | 'shell-only' | 'none'
  /** Consumed by budget admission: does this runtime report spend in USD? */
  readonly reportsCost: boolean
  /**
   * Consumed by M51's behavioural breaker: does this runtime say what came BACK from a tool call?
   *
   * A detector that cannot tell a finished call from a running one has no way to say a quiet
   * twenty-minute build is not a loop, so a runtime answering `false` here would have to be read
   * with the error-storm arm suppressed entirely. Both rows answer `true` today, each by its own
   * proof (`capabilities.ts`) -- this exists so a third runtime that cannot is refused an arm
   * rather than silently mis-judged by it.
   */
  readonly reportsToolResults: boolean
}

/**
 * Everything the adapter needs to spawn one run (M12 spec §7, ADR 0001 §3/§5.5). `worktreePath` and
 * `pauseFlagPath` are supplied by the caller, already absolute.
 *
 * M12 Decision of Record #1: no caller outside `packages/providers` may know that a runtime keeps a
 * settings file, a hook script, or where either lives -- `settingsPath` and `hookPath` used to live
 * here for exactly that reason, and both are gone. `runDir` is the one opaque handle the
 * orchestrator still supplies (`packages/control`'s `runFilePaths`, an already-created, empty
 * per-run scratch directory); everything an adapter keeps inside it is that adapter's own business,
 * reported back to the caller opaquely on `RunHandle.runFiles` for the one thing a caller genuinely
 * needs it for: a resumed run finding the same files.
 */
export interface StartRunInput {
  readonly runId: RunId
  readonly prompt: string
  readonly worktreePath: string
  readonly pauseFlagPath: string
  readonly runDir: string
  /**
   * The permission matrix's resolved deny list for this run (M18 Task 5), already written to disk
   * by the caller as `permissions.json` inside `runDir` (`packages/control`'s
   * `writePermissionsFile`, called once per start AND once per resume) -- an adapter never resolves
   * the matrix itself, only tells the child where to find the resolved file, exactly the way
   * `pauseFlagPath` already works. Required, not optional: every dispatch site writes the file
   * before calling `start()`, even when the resolved deny list is empty.
   */
  readonly permissionsFilePath: string
  readonly gitIdentity: {
    readonly name: string
    readonly email: string
  }
  /**
   * The resolved model override (M10 §6), already the caller's chosen value -- an adapter does not
   * itself consult a worker/roster/template chain, `resolveRuntime` does that before calling
   * `start()`. `undefined` means "no override": `--model` is omitted entirely rather than passed
   * with some sentinel, so a legacy run with no override behaves exactly as it did before this
   * field existed.
   */
  readonly model?: string
  /**
   * M52 R4: the PLAINTEXT run token this spawn's child carries, whose sha256 is already on the
   * `SlaveRun` row and inside the `permissions.json` the caller just wrote. The adapter puts it in
   * exactly one place -- the child's environment -- and never writes it anywhere.
   *
   * OPTIONAL for the same reason `resume`'s fourth parameter is (M52 plan erratum E7): `Checkpoint`
   * may not gain a field with no matching Prisma column, and a token file in `runDir` would be
   * readable by every sibling run under the same uid. Optional cannot widen anything here -- an
   * absent token means the key is absent from the child's environment, and the child then meets a
   * `tokenHash` it cannot match, which denies every tool call rather than allowing one.
   */
  readonly runToken?: string
}

/**
 * The provider-private files one run needs in order to be resumed later, keyed by CHANNEL NAME
 * (M56a R7).
 *
 * Until this milestone it was a frozen `{ settingsPath, hookPath }` pair named after the two
 * Postgres columns it ends up in, and Cursor already reused that pair for two files that are
 * neither a settings file nor a hook. The keys are now whatever that provider's manifest declares
 * in `runFiles.channels`, and `checkpointRunFiles` below is the ONE place they are mapped onto the
 * columns.
 *
 * `Readonly<Record<string, string>>` and not a union of the known channel names: the keys are DATA
 * in a manifest, and a type that enumerated them would put the same list in two places -- which is
 * the thing this milestone exists to stop doing.
 */
export type RunFiles = Readonly<Record<string, string>>

/** What `start()` reports back: enough to find and signal the process later. */
export interface RunHandle {
  readonly runId: RunId
  readonly pid: number
  /**
   * The files this run's adapter actually wrote, under the channel names its manifest declares. The
   * orchestrator relays them into the checkpoint through `checkpointRunFiles` and never interprets
   * them -- only the adapter that produced them reads them back (`resume`, off
   * `Checkpoint.settingsPath`/`.hookPath`).
   */
  readonly runFiles: RunFiles
}

/**
 * The provider-neutral contract every runtime adapter implements (M12 spec §7).
 *
 * ONE DECLARATION (M56a R1). It was built incrementally across M3 as two declaration-merged blocks
 * so that each task's diff stayed legible against the interface's own history; that history is
 * three milestones old, and a contract nobody can read in one screen is the thing M56a exists to
 * fix. It also lived in the CLAUDE adapter's own file, which both adapters imported it from --
 * nothing about it is Claude-specific, and it now lives where that is visible.
 *
 * `requestPause` and `awaitPause` (M3 Task 8) briefly lived here too and are gone (M12 Task 4,
 * controller ruling). They only ever worked for a run registered in *this adapter instance's own
 * in-memory state*, but pause is a cross-process control signal -- a CLI invocation, a web request
 * and the daemon each call it from a process that never called this run's `start()` -- so nothing
 * could ever call them for real (M12 Task 3 proved this). Pause is a stateless flag-file write
 * instead (`packages/providers`'s `signalPause`); the adapter itself has no pause method at all.
 *
 * What M56a deliberately did NOT do to this interface: it added no method, removed none, renamed
 * nothing, and changed no signature but `runFiles`'s type.
 */
export interface SlaveRuntimeAdapter {
  /**
   * Which provider this adapter IS, in the `ProviderKind` spelling (M56a R1).
   *
   * It was `id: string` and `ClaudeCodeAdapter`'s was `'claude-code'` -- HYPHENATED, and not the
   * enum member `claude_code` -- which is a wrinkle two comments in this tree existed to warn
   * about (`packages/control/src/index.ts:16-19`, `apps/web/src/server/overview.ts:762-765`). One
   * spelling now, and a registry that can assert an adapter is the kind it was registered under.
   */
  readonly kind: ProviderKind
  getCapabilities(): ProviderCapabilities
  /**
   * The models an operator can pick for this provider (M25 §5.1) -- `listProviderModels(kind)`
   * gives the same answer without an adapter.
   */
  listModels(): Promise<ModelListing>
  start(input: StartRunInput): Promise<RunHandle>
  events(runId: RunId): AsyncIterable<RuntimeEvent>
  cancel(runId: RunId): Promise<void>
  /**
   * Clears `checkpoint.pauseFlagPath`, **verifies it is actually absent**, then spawns the runtime
   * against `checkpoint.sessionId` in `checkpoint.worktreePath`, with the same settings and
   * permission posture the paused run used (ADR 0001 §5.7/§6). The verification is the point of the
   * step, not ceremony: a flag file that survives the clear attempt makes the hook deny the resumed
   * run's first tool call, and every one after it -- a resumed run that looks, from the outside,
   * exactly like a run stuck in a pause loop, with no error anywhere to say why. `resume` never
   * rewrites `checkpoint.sessionId` (ADR 0001 §5: a plain `--resume` reports the same UUID) and
   * never passes a flag that would mint a new one (each provider's manifest names its own, in
   * `resume.neverPass`).
   *
   * `queuedInstruction` becomes the resume prompt verbatim when supplied. The CLI has no notion
   * that a resume follows a pause -- it treats the prompt as an ordinary next turn (ADR 0001 §6).
   * When `null` (no instruction queued), a generic continuation prompt is substituted: headless mode
   * still needs *some* text, and there is no queued operator instruction to supply it.
   *
   * Resuming a `runId` this adapter instance never itself `start()`-ed is the normal case, not an
   * error -- that is exactly what surviving a daemon restart means. `checkpoint` alone carries
   * everything the spawn needs (`settingsPath`, `hookPath`, `gitAuthorName`, `gitAuthorEmail`,
   * alongside `worktreePath`/`pauseFlagPath`/`sessionId`), so `resume` does not look up any prior
   * in-memory record of `runId` before spawning.
   *
   * `runToken` (M52 R4) is the ROTATED token for this spawn -- a resume mints a fresh one, so a
   * token recovered from an old worktree, an old process listing or a stale environment dump is
   * dead the moment the run resumes. Optional and last, so the ~20 existing call sites compile
   * unchanged; see `StartRunInput.runToken` for why optional cannot widen anything.
   */
  resume(
    runId: RunId,
    checkpoint: Checkpoint,
    queuedInstruction: string | null,
    runToken?: string,
  ): Promise<RunHandle>
}

/**
 * The ONE place a run's channels are mapped onto the two `Checkpoint` columns (M56a R7).
 *
 * `Checkpoint.settingsPath` and `.hookPath` are NOT NULL (`model Checkpoint`'s columns of those two
 * names, `packages/db/prisma/schema.prisma`) and M56a runs no migration, so exactly two of a
 * provider's channels survive a pause: the ordered pair its manifest names in `runFiles.persisted`.
 * Every dispatch site relays through this function -- `apps/orchestrator/src/tick.ts`, `planning.ts`
 * and `review.ts` each used to spread `handle.runFiles` straight into the checkpoint's `spawn` -- so
 * the column names are spelled in this file and in the Prisma schema and nowhere else.
 *
 * WHAT THIS GENERALISES AND WHAT IT DOES NOT. The ADAPTER side: a provider with three run files can
 * declare three channels and its adapter can return them. The PERSISTENCE side is unchanged, and
 * the residual is named rather than hidden -- the third would have to be re-derivable at resume
 * time from `runDir` or the worktree, so the gate asserts `channels.length === 2` for every
 * registered provider until `Checkpoint` gains a `runFiles Json` column. Making that column now
 * would be a migration in a migration-free milestone, for a provider that does not exist, against a
 * shape nobody has measured.
 *
 * It THROWS on a missing channel rather than writing an empty string: both columns are NOT NULL, and
 * an empty settings path is a failure that surfaces hours later as a resumed run whose gate never
 * registers, which is precisely the silent failure `claudeFlags` refuses a relative path to prevent.
 */
export function checkpointRunFiles(
  kind: ProviderKind,
  handle: RunHandle,
): { readonly settingsPath: string; readonly hookPath: string } {
  const [settingsChannel, hookChannel] = manifestFor(kind).runFiles.persisted
  const settingsPath = handle.runFiles[settingsChannel]
  const hookPath = handle.runFiles[hookChannel]
  if (settingsPath === undefined || hookPath === undefined) {
    throw new Error(
      `checkpointRunFiles: ${kind} reported no path for ` +
        `${settingsPath === undefined ? JSON.stringify(settingsChannel) : JSON.stringify(hookChannel)}; ` +
        `its manifest persists ${JSON.stringify(manifestFor(kind).runFiles.persisted)} and the handle carried ` +
        `${JSON.stringify(Object.keys(handle.runFiles))}`,
    )
  }
  return { settingsPath, hookPath }
}
