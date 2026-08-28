/**
 * The mandatory CLI flags for every `cursor-agent` run this adapter spawns
 * (spec §7). Pure, like `claudeFlags`: given the same input it always returns
 * the same flags in the same order and never touches the filesystem or a child
 * process. It returns FLAGS ONLY -- the prompt is a positional argument and
 * belongs to the caller that assembles argv, exactly as it does for Claude.
 *
 * Every flag below was read off `cursor-agent --help` (binary
 * `2026.08.11-e8db854`, 2026-08-26) rather than off vendor documentation; the
 * verified table with the help text's own words is in the Task 11 report.
 *
 * WHY EACH ONE IS HERE:
 *
 * - `--print` -- mandatory. `--output-format` "only works with --print", and
 *   without it the agent runs interactively and the stream parser is handed
 *   nothing it can read.
 * - `--output-format stream-json` -- the NDJSON `parseCursorLine` parses.
 * - `--trust` -- mandatory, and its absence is INVISIBLE. Measured while
 *   recording Task 10's fixture: in a directory the user has not already
 *   trusted, `cursor-agent` exits 1 with a completely empty stdout -- no
 *   `system`/`init` line, no `result` line -- and prints "Workspace Trust
 *   Required" to stderr only. Every fresh worktree this system creates is
 *   exactly such a directory, so without this flag every Cursor run fails, and
 *   it fails looking like a runtime that produced no output rather than like a
 *   missing flag.
 * - `--force` -- Cursor's equivalent of Claude's `bypassPermissions`: "Force
 *   allow commands unless explicitly denied". The trailing clause is
 *   load-bearing -- it is what keeps the write gate's `permission: "deny"`
 *   effective, so the gate survives this flag. Measured in Task 11's R5 run 1:
 *   with `--force` in place, a hook that denies still stops the command.
 *
 * NEVER-PASS LIST. Each of these is a flag `cursor-agent` really has and that
 * this adapter must never emit; the tests assert each one separately so that a
 * future edit adding any of them fails on its own named line.
 *
 * - `-w` / `--worktree [name]` -- Cursor has its own worktree feature. This
 *   system already manages worktrees and a second one under
 *   `~/.cursor/worktrees/` would split the run across two trees. Note the
 *   argument is OPTIONAL, so a bare `-w` is accepted and silently relocates
 *   the whole run.
 * - `--stream-partial-output` -- "Stream partial output as individual text
 *   deltas (only works with --print and stream-json format)". `parseCursorLine`
 *   assumes one `assistant` line is one whole message; the recorded fixture's
 *   two assistant lines each carry exactly one complete `text` block and that
 *   is the whole of the evidence behind it. This flag would fragment every
 *   message into deltas and turn the operator's feed into token soup, and the
 *   parser would be "correct" the entire time.
 * - `--yolo` -- "Alias for --force (Run Everything)". Passing both is noise.
 * - `--plan` and `--mode` -- read-only execution modes ("plan: read-only/
 *   planning (analyze, propose plans, no edits)", "ask: Q&A style ...
 *   (read-only)"). A worker that cannot edit is not a worker.
 */
export interface CursorFlagsInput {
  /**
   * The resolved model, or omitted when none resolved. There is deliberately
   * no sentinel value: `--model` is omitted entirely rather than passed with
   * something meaning "default".
   */
  readonly model?: string | undefined
  /**
   * The session to continue. Shaped as an object rather than a bare
   * `resumeSessionId?: string` so that "resume this session" and "do not
   * resume" cannot be confused with "resume, id unknown" -- see the guard
   * below for why that distinction is worth a wrapper object.
   */
  readonly resume?: { readonly sessionId: string } | undefined
}

export function cursorFlags(input: CursorFlagsInput = {}): readonly string[] {
  const flags: string[] = ['--print', '--output-format', 'stream-json', '--trust', '--force']

  if (input.model !== undefined) {
    // An empty `--model` argument is a programming error in the resolver, not a
    // request for the default: the caller signals "no model" by omitting the
    // field entirely.
    requireUsable('model', input.model)
    flags.push('--model', input.model)
  }

  if (input.resume !== undefined) {
    // `--resume [chatId]` takes an OPTIONAL argument, and that is a trap.
    // Help reads: "--resume [chatId]  Select a session to resume (default:
    // false)". The prompt is a POSITIONAL argument, so `cursor-agent --print
    // --resume "do the thing"` does not resume anything -- it hands the prompt
    // to the flag as a chat id and leaves the run with no prompt at all. This
    // function can never emit a bare `--resume` (the flag and its id are pushed
    // together, in one statement), and an id that could not serve as one is
    // rejected before a process exists, the same way `claudeFlags` rejects a
    // relative `settingsPath` and for the same reason: the failure it prevents
    // is silent.
    requireUsable('resume.sessionId', input.resume.sessionId)
    flags.push('--resume', input.resume.sessionId)
  }

  return flags
}

function requireUsable(field: string, value: string): void {
  if (value.trim() === '') {
    throw new Error(
      `cursorFlags: ${field} must be a non-empty, non-whitespace string, got ${JSON.stringify(value)}. ` +
        'Omit the field entirely rather than passing an empty value.',
    )
  }
}
