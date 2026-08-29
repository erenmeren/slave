import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

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

/**
 * The Cursor half of spec §5.5's pre-flight gate check -- "a written hooks file is not an armed
 * gate". Spawns `gatePath` directly (never through `cursor-agent`), twice, and asserts BOTH
 * directions:
 *
 * - flag file present -> `permission: "deny"` on stdout, exit 0
 * - flag file absent  -> `{"permission":"allow"}` on stdout, exit 0
 *
 * One direction is not enough, for exactly the reason `claude/flags.ts`'s `preflightGate` gives:
 * `cursor-shell-gate.sh` also denies when `AITEAMOS_PAUSE_FLAG` is unset -- its own deliberate
 * loud-misconfiguration path -- so a check asserting only "flag present => deny" is satisfied by a
 * hook that denies unconditionally, which gates nothing while looking armed. The second direction
 * is what proves the script discriminates.
 *
 * **The allow half differs from Claude's and the difference is the whole point of writing this
 * separately rather than reusing `preflightGate`** (Task 11 §8(d)). Claude's gate allows by
 * staying SILENT, and `preflightGate` asserts empty stdout for the allow case. Cursor classifies
 * exit 0 with empty stdout as a hook FAILURE (`empty_stdout`), which `failClosed: true` converts
 * into a block -- so a Cursor gate must speak its allow out loud, and a pre-flight copied from
 * Claude's would reject a correct one.
 *
 * What this does NOT prove, same as Claude's: that `cursor-agent` will actually invoke the hook. A
 * correct script named in a hooks file the CLI never reads passes this and gates nothing. It is a
 * cheap necessary condition on the script, not a sufficient one on the wiring.
 *
 * `flagPath` is deliberately not a parameter -- an isolated temporary flag file is minted here and
 * removed afterwards, so it is impossible to point this probe at a live run's own
 * `pauseFlagPath` and silently disarm that run's gate mid-flight.
 */
export async function cursorPreflightGate(input: { readonly gatePath: string }): Promise<void> {
  const { gatePath } = input
  const dir = await mkdtemp(join(tmpdir(), 'aiteamos-cursor-preflight-'))
  const flagPath = join(dir, 'pause.flag')

  try {
    const armed = await runGateScript({ gatePath, flagPath, flagPresent: true })
    if (armed.exitCode !== 0 || permissionOf(armed.stdout) !== 'deny') {
      throw new Error(
        `cursorPreflightGate: gate at ${gatePath} did not deny with the pause flag present ` +
          `(exit code ${String(armed.exitCode)}, stdout ${JSON.stringify(armed.stdout)}). ` +
          'A working pause gate must deny every tool call while the flag file exists.',
      )
    }

    const disarmed = await runGateScript({ gatePath, flagPath, flagPresent: false })
    if (disarmed.exitCode !== 0 || permissionOf(disarmed.stdout) !== 'allow') {
      throw new Error(
        `cursorPreflightGate: gate at ${gatePath} did not allow with the pause flag absent ` +
          `(exit code ${String(disarmed.exitCode)}, stdout ${JSON.stringify(disarmed.stdout)}). ` +
          'A hook that denies with the flag both present and absent gates nothing -- it is not an ' +
          'armed gate, it is a broken run. Note that SILENCE is not an allow here: Cursor reads ' +
          'exit 0 with empty stdout as a hook failure, which fails closed.',
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The `permission` field of the hook's response, or `undefined` when stdout is not one. */
function permissionOf(stdout: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const result = hookResponseSchema.safeParse(parsed)
  return result.success ? result.data.permission : undefined
}

// Only `permission` is read. The binary's own response validator accepts `permission`,
// `user_message` and `agent_message` (Task 11 §3 Q4); the operator message is the gate's business
// and this probe has no opinion on its wording.
const hookResponseSchema = z.object({ permission: z.string() })

interface GateRunResult {
  readonly stdout: string
  readonly exitCode: number | null
}

/**
 * Spawns the gate script with `AITEAMOS_PAUSE_FLAG` pointing at `flagPath`, having first created
 * or removed the flag file itself.
 *
 * `cursor-shell-gate.sh` opens with `cat > /dev/null`, draining what the real CLI would have piped
 * in as the hook payload. Spawned from Node with piped stdio, nothing ever ends that pipe, so the
 * drain would block forever and this probe would hang rather than pass or fail -- `stdin.end()`
 * below is the EOF a real invocation would have supplied.
 */
async function runGateScript(input: {
  readonly gatePath: string
  readonly flagPath: string
  readonly flagPresent: boolean
}): Promise<GateRunResult> {
  if (input.flagPresent) {
    await writeFile(input.flagPath, '')
  } else {
    await rm(input.flagPath, { force: true })
  }

  return new Promise<GateRunResult>((resolve, reject) => {
    const child = spawn(input.gatePath, [], {
      env: { ...process.env, AITEAMOS_PAUSE_FLAG: input.flagPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    // Drained, not asserted on: the verdict is stdout shape plus exit code, and a real failure
    // path (exit 2) puts its reason on stderr for Cursor, not for this probe.
    child.stderr.resume()

    child.once('error', fail)
    child.once('close', (exitCode: number | null) => {
      if (settled) return
      settled = true
      resolve({ stdout, exitCode })
    })

    child.stdin.end()
  })
}
