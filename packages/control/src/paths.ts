import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RunId } from '@slave-of-ai/domain'

/**
 * Where the run's own files live: **outside the repository entirely** (M52 R4).
 *
 * Until this milestone this was `<repoPath>/.slaveofai/runs/<runId>` -- inside the tree the worker
 * edits. `scripts/lib/permissions.sh` recorded the consequence in its own header: "A run that
 * deletes its own permissions file disarms the matrix for its remaining tool calls." Under
 * default-deny that stops being a hole and becomes a bypass of everything, so the directory moves
 * out of the repository: `$SLAVEOFAI_STATE_DIR`, else `$XDG_STATE_HOME/slaveofai`, else
 * `~/.local/state/slaveofai`, then `runs/<runId>`, created 0700.
 *
 * WHAT THE MOVE BUYS, EXACTLY. No run file is inside the tree a verify runs in or a merge cleans,
 * and no repo-scoped delete, `git clean` or branch switch can take a verdict with it. It is NOT a
 * boundary the worker cannot cross: the child is handed the absolute path of its own
 * `permissions.json` and runs under the uid that owns this 0700 directory, so a worker granted
 * `run_commands` can still rewrite its own verdict. `scripts/lib/permissions.sh`'s exit-2 arm
 * states that residual in full; the authority a worker cannot forge is the database row
 * (`SlaveRun.runTokenHash`), which is what the broker authorises against.
 *
 * The pause flag, the permissions file, the tool-results tap and the broker channel all move with
 * it -- every one of them is derived from `runDir` by a single helper, and none of them was ever a
 * path a caller spelled itself.
 *
 * `repoPath` stays a parameter and its `statSync` preflight stays: every caller has it,
 * `signalPause` (`pause.ts`) re-derives this same path from the same two values, and a run whose
 * repository is missing or is not a directory is a broken run whether or not its scratch directory
 * lives there. The check is now an assertion about the RUN rather than about where the directory
 * goes, and its own two tests (`paths.test.ts`) are unchanged -- which is a signal rather than a
 * convenience: the check did not change meaning, only the directory moved.
 *
 * What did NOT move, and must not be claimed to have (plan erratum E4): `<repo>/.slaveofai/worktrees`
 * (`apps/orchestrator/src/worktree.ts`) and `<repo>/.slaveofai/artifacts` (`verify.ts`, `merge.ts`).
 * A worktree is the worker's workspace and an artifact is a log a person downloads through
 * `/api/w/:id/tasks/:id/artifacts/:id`; neither is a verdict about the worker.
 *
 * A run in flight across the upgrade keeps its ORIGINAL directory and needs no migration: both
 * adapters re-derive `runDir` from `dirname(checkpoint.pauseFlagPath)`, which is an absolute path
 * recorded when the run started.
 *
 * `runDir` is this function's whole contribution: an empty, already-created scratch directory,
 * unique per run. What a provider adapter writes inside it -- a settings file, a hook script,
 * anything else -- is that adapter's own business (M12's Decision of Record #1: no caller outside
 * `packages/providers` may know that a provider has a settings file, a hook script, or a flag
 * file).
 *
 * Preflight the root before the recursive mkdirSync: on this host a nonexistent parent under
 * a pseudo-filesystem (/proc was the recorded case — pause.test.ts) hangs recursive mkdirSync
 * FOREVER, with no error to catch. statSync answers immediately for the same inputs, so a bad
 * root becomes an actionable throw on the tick's hot path instead of a silent stall.
 */
/**
 * WHERE a run's directory is, deciding nothing and creating nothing (M52 t4 fix round 1).
 *
 * The pure half of {@link runFilePaths}: the same three-step state-root rule, spelled once, with no
 * `statSync`, no `mkdirSync` and no opinion about whether the run is healthy. A READER wants this
 * one -- the broker's pass asks every live run where its channel would be, once every half second,
 * and `runFilePaths` there meant a synchronous recursive `mkdirSync` per run per pass on the event
 * loop, for directories it had no business creating. (Measured: with the broker pass on its own
 * interval beside the tick, that synchronous work widened the window between `requestPause`'s claim
 * and `steerRun`'s second statement enough to make `gate:m51-breaker` fail two runs in five.)
 *
 * A WRITER still wants {@link runFilePaths}: the directory has to exist before anything is written
 * into it, and the repo-path assertion is about the RUN.
 */
export function runDirPathFor(runId: RunId): string {
  return join(stateRoot(), 'runs', runId)
}

/**
 * THE THREE-STEP STATE-ROOT RULE, spelt once (F R7).
 *
 * `$SLAVEOFAI_STATE_DIR`, else `$XDG_STATE_HOME/slaveofai`, else `~/.local/state/slaveofai`. It
 * was inline in {@link runDirPathFor} until a Supervisor chat turn needed a scratch directory of
 * its own; two copies of a rule about WHERE this installation keeps its state is exactly the kind
 * of thing that drifts once and is wrong forever.
 */
function stateRoot(): string {
  const stateDir = process.env['SLAVEOFAI_STATE_DIR']
  const xdgStateHome = process.env['XDG_STATE_HOME']
  return stateDir !== undefined && stateDir !== ''
    ? stateDir
    : xdgStateHome !== undefined && xdgStateHome !== ''
      ? join(xdgStateHome, 'slaveofai')
      : join(homedir(), '.local', 'state', 'slaveofai')
}

/**
 * Where ONE Supervisor chat turn's scratch files live (F R7), created 0700.
 *
 * A read-only turn is armed like a run: a `permissions.json` the gate reads, and a token whose
 * hash is in it. So it gets a run's kind of directory -- outside the repository, under the same
 * state root, mode 0700 -- in a sibling of `runs/` rather than inside it, because a chat turn is
 * not a run: it has no `SlaveRun` row, no pause flag, no broker channel and nothing to resume.
 *
 * Keyed on the MESSAGE, which is unique and is what a person looking at a stuck turn has in hand.
 * A turn reclaimed after its TTL reuses the directory and rewrites the file, which is right: the
 * verdict is rewritten at every start, exactly as a run's is, and never merged.
 *
 * The repo-path preflight is {@link runFilePaths}' and for its reason: a turn whose repository is
 * missing is a broken turn whether or not its scratch directory lives there, and `statSync`
 * answers immediately where a recursive `mkdirSync` under a pseudo-filesystem can hang forever.
 */
export function chatTurnFilePaths(repoPath: string, messageId: string): { turnDir: string } {
  let root
  try {
    root = statSync(repoPath)
  } catch (error) {
    throw new Error(
      `chatTurnFilePaths: cannot stat repo path ${repoPath} (turn ${messageId}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!root.isDirectory()) throw new Error(`chatTurnFilePaths: repo path is not a directory: ${repoPath} (turn ${messageId})`)
  const dir = join(stateRoot(), 'chat-turns', messageId)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(
      `chatTurnFilePaths: cannot create turn dir ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { turnDir: dir }
}

export function runFilePaths(repoPath: string, runId: RunId): { runDir: string; pauseFlagPath: string } {
  let root
  try {
    root = statSync(repoPath)
  } catch (error) {
    throw new Error(`runFilePaths: cannot stat repo path ${repoPath} (run ${runId}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!root.isDirectory()) throw new Error(`runFilePaths: repo path is not a directory: ${repoPath} (run ${runId})`)
  const dir = runDirPathFor(runId)
  try {
    // 0700 on the whole chain: a run directory holds the verdict that governs a worker, and this
    // machine may have other accounts on it. It does NOT protect a run from a SIBLING run under the
    // same uid -- that is what the token on the verdict is for, and why no plaintext token is ever
    // written into this directory.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(`runFilePaths: cannot create run dir ${dir}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { runDir: dir, pauseFlagPath: join(dir, 'pause.flag') }
}
