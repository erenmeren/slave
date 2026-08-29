import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/**
 * The `.cursor/hooks.json` shape that arms `scripts/cursor-shell-gate.sh` for one run, MEASURED
 * against `cursor-agent` 2026.08.11-e8db854 in M12 Task 11's R5 runs rather than taken from vendor
 * documentation. This mirrors `claude/settings.ts` -- the same "the adapter provisions its own run
 * files" concern (M12 Decision of Record #1), for the other runtime.
 *
 * Three measured facts are baked into this type, and each of them is a trap if forgotten:
 *
 * 1. **`cursor-agent` reads this file FROM THE WORKSPACE** (Task 11 §3 Q1), resolving
 *    `<workspace>/.cursor/hooks.json` as one of six merged config paths. There is no
 *    `--settings`-style flag; the workspace copy is the entire mechanism, which is exactly what
 *    makes per-run gate isolation possible at all -- each run gets its own worktree, so each run
 *    gets its own hooks file.
 *
 *    **"The workspace" is the GIT ROOT, not the process's cwd** -- measured by Task 12, and the
 *    correction matters. `cursor-agent` starts a per-repository worker (its socket and log land
 *    under `~/.cursor/projects/<git-root-slug>/`), and the project hook config is resolved against
 *    that root. A run whose cwd is a plain SUBDIRECTORY of a repository therefore has its
 *    `.cursor/hooks.json` ignored in silence, and Task 12's two live runs are exactly that
 *    mistake, made in the test workspace rather than in this code. It costs this system nothing in
 *    production -- a real run's worktree is a `git worktree`, whose own `rev-parse --show-toplevel`
 *    IS the worktree directory -- but it is a live trap for anyone pointing a run at a directory
 *    inside a larger checkout, and the failure is invisible: no error, no warning, just a gate that
 *    was never loaded.
 *
 * 2. **`command` is a SHELL COMMAND LINE, not an argv array** (Task 11 §3 Q2). Cursor evaluates
 *    ``${command} <<'CURSOR_HOOK_EOF'…`` in a shell. That is why `shellQuote` below exists: a gate
 *    path containing a space would otherwise split into a command plus an argument, and while that
 *    fails loudly under `failClosed` (a spawn error is a blocked tool call), failing loudly on
 *    every tool call of every run is not a good place to discover a quoting bug.
 *
 * 3. **`failClosed: true` is not decoration -- omitting it leaves a gate that fails OPEN**
 *    (Task 11 §3 Q6, measured both ways in one controlled pair of runs). Without it, a hook that
 *    crashes, times out, writes nothing, or writes unparseable output lets the command run as if
 *    no gate existed, and nothing anywhere says the gate did not answer. That is the one failure
 *    this milestone cannot tolerate: the system would report a paused run as contained while it
 *    kept writing. Typed as the literal `true` so it cannot be set to anything else.
 */
export interface CursorHooksConfig {
  readonly version: 1
  readonly hooks: {
    /**
     * Fires immediately before a shell command runs, with the pending command on stdin
     * (Task 11 §3 Q2/Q3). Kept even though `preToolUse` below already covers shell calls: the two
     * are independent registrations, and a gate that survives either one of them being dropped or
     * renamed by a future CLI is cheaper than a gate that silently stops covering shell commands.
     */
    readonly beforeShellExecution: readonly CursorHookEntry[]
    /**
     * Fires ahead of `beforeShellExecution` for EVERY tool, with `tool_name` of `Read`, `Write`
     * and `Shell` all measured (Task 11 §3, W6), and a block here measured stopping a file write,
     * not only a shell command.
     *
     * **M13 Task 9 measured this registration blocking a file write, not only a shell command.**
     * With the pause flag present, a run that attempted a shell command and a file write had BOTH
     * refused, `result.rejected` on each, `reason` the gate's `user_message` verbatim; the control
     * run (flag absent) shows both succeeding. Evidence:
     * `packages/providers/test/fixtures/cursor/gate/` (README, `hooks.json`,
     * `run-2-flag-present.ndjson` lines 10 and 12, `run-2-hook.log`). `capabilitiesOf('cursor').gate`
     * now reads `'all-tools'` on the strength of this recording (`packages/providers/src/capabilities.ts`).
     * Measured on `cursor-agent 2026.08.25-3e8eec8` only -- the binary self-updates, and the
     * fixture README records the version per payload -- and only for a shell call and an edit
     * call; no MCP or subagent tool call has been exercised.
     *
     * Deliberately registered with NO `matcher`, and this is LOAD-BEARING, not merely cautious: in
     * the same recording, the file write was stopped at a `preToolUse` invocation whose
     * `tool_name` was `"Read"` -- Cursor's edit tool reads its target before writing it, and both
     * steps are gated under the edit call's own id, so the write never reached a `tool_name:
     * "Write"` invocation at all. A `matcher` is a regex tested against `tool_name`, so scoping
     * this to (say) `^(Write|Shell)$` -- which reads as an obviously safe narrowing -- would have
     * let this exact write through. `Read`, `Write` and `Shell` are the only `tool_name` values
     * anyone has measured, a matcher that misses one is a silent hole in the gate, and the cost of
     * having none is one extra hook invocation per tool call.
     */
    readonly preToolUse: readonly CursorHookEntry[]
  }
}

export interface CursorHookEntry {
  readonly command: string
  readonly failClosed: true
}

/**
 * POSIX single-quoting for a path that is about to be pasted into a shell command line. A single
 * quote inside the path is closed, escaped and reopened (`'\''`), which is the only form that is
 * safe for every byte a path can contain.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Where a run's hooks file lives, given its worktree. Not a caller-supplied path: nothing outside
 * this package may know that this runtime keeps a hooks file or where (M12 Decision of Record #1),
 * and `cursor-agent` would not read it anywhere else regardless.
 */
export function cursorHooksPath(worktreePath: string): string {
  return join(worktreePath, '.cursor', 'hooks.json')
}

/**
 * Builds the hooks object registering `gatePath` at every step this adapter gates. `gatePath` must
 * be absolute: Cursor evaluates the command with the workspace as cwd in one measured run and with
 * an empty `cwd` field in another (Task 11 §3 Q3 -- the payload's own `cwd` is not trustworthy),
 * so a relative path is a gate that may or may not resolve depending on which run it is.
 */
export function buildCursorHooks(input: { readonly gatePath: string }): CursorHooksConfig {
  if (!isAbsolute(input.gatePath)) {
    throw new Error(`buildCursorHooks: gatePath must be absolute, got ${JSON.stringify(input.gatePath)}`)
  }
  const entry: CursorHookEntry = { command: shellQuote(input.gatePath), failClosed: true }
  return { version: 1, hooks: { beforeShellExecution: [entry], preToolUse: [entry] } }
}

/**
 * The `.git/info/exclude` line that keeps this adapter's own file out of the run's git status.
 * Anchored with a leading `/` so it matches the workspace root's `.cursor/hooks.json` and not some
 * nested one a project might legitimately track.
 */
const EXCLUDE_LINE = '/.cursor/hooks.json'

/**
 * Writes the run's hooks file, creating the `.cursor` directory if the worktree does not have one.
 * Called on every spawn (`start` and `resume`), for the same reason `writeSettingsFile` is: a
 * resume is a spawn, and the file the resumed process reads must be the file this adapter
 * believes it wrote.
 *
 * The workspace itself must ALREADY exist, and that check is not ceremony. `mkdirSync` with
 * `recursive` would happily create the whole chain, so a run pointed at a worktree that was pruned
 * between pause and resume would get a brand-new empty directory instead of an error -- and then
 * spawn cleanly in it, because the cwd now exists. The run would report a healthy start and do its
 * work against nothing. Failing here names the missing worktree instead.
 *
 * **Two things this does that `writeSettingsFile` does not have to.** Claude's settings file lives
 * in `runDir`, outside the worktree entirely; Cursor's has to live INSIDE the run's checkout,
 * because that is the only place `cursor-agent` reads it from. So this file lands in a directory
 * that is also the agent's working tree -- somebody else's source repository -- and both of the
 * consequences are handled here rather than left for an operator to discover:
 *
 * 1. **It refuses to clobber a hooks file the project brought with it.** A checked-out project may
 *    legitimately ship its own `.cursor/hooks.json`; overwriting it would disarm whatever the user
 *    configured, silently. Only a file byte-identical to what this adapter would write is treated
 *    as its own and rewritten -- which is exactly the `resume()` case, and why this is not simply
 *    "refuse if the path exists".
 * 2. **It excludes itself from git.** Otherwise the run's own `git status` shows `?? .cursor/`, the
 *    agent sees a stray file containing an absolute local path to a gate script, and may well
 *    commit it. `writeCheckpoint`'s `dirtyFiles` would carry it too.
 */
export function writeCursorHooksFile(input: { readonly hooksPath: string; readonly gatePath: string }): void {
  if (!isAbsolute(input.hooksPath)) {
    throw new Error(`writeCursorHooksFile: hooksPath must be absolute, got ${JSON.stringify(input.hooksPath)}`)
  }
  const workspacePath = dirname(dirname(input.hooksPath))
  let workspaceIsDirectory = false
  try {
    workspaceIsDirectory = statSync(workspacePath).isDirectory()
  } catch {
    workspaceIsDirectory = false
  }
  if (!workspaceIsDirectory) {
    throw new Error(
      `writeCursorHooksFile: the run's workspace ${JSON.stringify(workspacePath)} is not an existing ` +
        'directory. Refusing to create it: a worktree that has gone missing must fail loudly here, ' +
        'not be silently replaced by an empty one the run then works in.',
    )
  }

  const desired = JSON.stringify(buildCursorHooks({ gatePath: input.gatePath }), null, 2)
  const existing = readFileIfPresent(input.hooksPath)
  if (existing !== null && existing !== desired) {
    throw new Error(
      `writeCursorHooksFile: ${JSON.stringify(workspacePath)} already has a .cursor/hooks.json that ` +
        'this adapter did not write. Refusing to overwrite it: a project that ships its own Cursor ' +
        'hooks has configured something deliberate, and replacing it would disarm that silently and ' +
        "leave a modified tracked file in the agent's working tree. Move or remove it, or run this " +
        'provider against a worktree that does not carry one.',
    )
  }

  // Excluded BEFORE the file exists, so there is no window in which a `git status` -- the agent's
  // own, or `writeCheckpoint`'s `dirtyFiles` -- can see it.
  excludeFromGit(workspacePath)
  mkdirSync(dirname(input.hooksPath), { recursive: true })
  writeFileSync(input.hooksPath, desired)
}

function readFileIfPresent(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Appends `EXCLUDE_LINE` to the exclude file governing `workspacePath`, once.
 *
 * **The path is asked of git, not derived, and that is a correction rather than a preference.**
 * The obvious implementation -- read `<workspace>/.git`, which `git worktree add` writes as a FILE
 * containing `gitdir: <repo>/.git/worktrees/<name>`, and append to `<that dir>/info/exclude` --
 * produces a file **git never reads**. Measured directly on a real `git init` + `git worktree add`
 * pair: with the line in the per-worktree gitdir, `git status --porcelain` still reported
 * `?? .cursor/`; with it in the common dir it reported nothing. `git rev-parse --git-path
 * info/exclude` inside a linked worktree answers `<repo>/.git/info/exclude`, because `info/` is one
 * of the paths git redirects to the common directory. Asking git is also the only version that
 * stays correct for layouts nobody here has tried -- submodules, a `GIT_DIR` in the environment,
 * `--separate-git-dir`.
 *
 * A directory that is not a git repository at all is not an error: there is simply nothing to
 * exclude from. Every unit test in `cursor-adapter.test.ts` runs in exactly such a directory, and
 * so would an operator pointing a run at one.
 */
function excludeFromGit(workspacePath: string): void {
  let excludePath: string
  try {
    excludePath = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], {
      cwd: workspacePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // Not a repository, or no git on PATH. Nothing to exclude from; the hooks file is still
    // written, because the gate matters more than the tidiness.
    return
  }
  if (excludePath === '') return

  const current = readFileIfPresent(excludePath) ?? ''
  // Idempotent: every spawn of every run rewrites the hooks file, and an exclude file that grew a
  // duplicate line per resume would be its own kind of pollution.
  if (current.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) return

  mkdirSync(dirname(excludePath), { recursive: true })
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`
  writeFileSync(excludePath, `${prefix}${EXCLUDE_LINE}\n`)
}
