import { mkdirSync, statSync, writeFileSync } from 'node:fs'
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
     * **Registered even though `capabilitiesOf('cursor').gate` still reads `'shell-only'`, and
     * that asymmetry is deliberate.** Task 12's two live runs could not produce a measured block
     * (see the task report: the workspace they ran in was a plain subdirectory of a git
     * repository, and `cursor-agent` keys its worker -- and therefore its project hook config --
     * to the git root, so the hooks file this adapter wrote was never the one loaded). A
     * capability may only ever be widened by proof, so the claim stays narrow while the
     * registration stays broad: understating what is armed is safe in the one direction that
     * matters, and the reverse is not.
     *
     * Deliberately registered with NO `matcher`. A `matcher` is a regex tested against
     * `tool_name`, so scoping this to (say) `^(Write|Shell)$` would depend on knowing Cursor's
     * complete tool-name vocabulary, and the three names above are the only ones anyone has
     * measured. A matcher that misses a tool name is a silent hole in the gate, and the cost of
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
  mkdirSync(dirname(input.hooksPath), { recursive: true })
  writeFileSync(input.hooksPath, JSON.stringify(buildCursorHooks({ gatePath: input.gatePath }), null, 2))
}
