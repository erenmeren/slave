import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

/**
 * The mandatory CLI flags for every `claude` run this adapter spawns
 * (ADR 0001 §3, spec §5.5). Pure: given the same input it always returns
 * the same flags in the same order and never touches the filesystem or a
 * child process.
 *
 * `--settings` must be an **absolute** path. ADR 0001 measured only that
 * form -- the `$VAR` form inside a settings file was never tested -- and a
 * settings file the CLI cannot find never registers the `PreToolUse` hook.
 * That means pause silently does not work, with no error anywhere in the
 * event stream: the run spawns cleanly, every tool call goes through
 * unimpeded, and the terminal `result` event reports a clean success. A
 * relative path here is the cheapest possible guard against the mechanism
 * the whole milestone depends on, so it is rejected before a process is
 * ever spawned.
 *
 * `--no-session-persistence` and `--fork-session` are never included:
 * ADR 0001 §3 records that the former makes resume impossible and the
 * latter mints a new session id on resume.
 */
export function claudeFlags(input: { readonly settingsPath: string }): readonly string[] {
  if (!isAbsolute(input.settingsPath)) {
    throw new Error(
      `claudeFlags: settingsPath must be absolute, got ${JSON.stringify(input.settingsPath)}`,
    )
  }
  return [
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--settings',
    input.settingsPath,
    '--include-hook-events',
  ]
}

const denyOutputSchema = z.object({
  hookSpecificOutput: z.object({
    permissionDecision: z.literal('deny'),
  }),
})

/** `true` when `stdout` parses as the hook's deny-JSON shape (spec §5.3). */
function isDenyOutput(stdout: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return false
  }
  return denyOutputSchema.safeParse(parsed).success
}

interface HookRunResult {
  readonly stdout: string
  readonly exitCode: number | null
}

/**
 * Spawns `hookPath` directly (not through the `claude` CLI) with
 * `AITEAMOS_PAUSE_FLAG` set to `flagPath`. Whether the flag file at that
 * path exists is the caller's concern (see `withFlagFile`) -- this function
 * only runs the script and reports what it did.
 *
 * `pause-gate.sh` opens with `cat > /dev/null`, draining whatever the real
 * CLI would have piped in as the hook payload, before it looks at the flag
 * at all. Spawned from Node with default piped stdio, nothing ever writes
 * to or ends that pipe, so the drain blocks forever and the child never
 * exits -- the pre-flight would hang rather than pass or fail. Closing
 * stdin immediately unblocks it exactly like an EOF from a real pipe would.
 */
function runHookScript(input: { readonly hookPath: string; readonly flagPath: string }): Promise<HookRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.hookPath, [], {
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
    // Drained, not asserted on: a real failure mode (e.g. exit 2) reports its
    // reason on stderr, but the pre-flight's verdict is stdout shape + exit
    // code, matching pause-gate.sh's documented contract.
    child.stderr.resume()

    child.once('error', fail)
    child.once('close', (exitCode: number | null) => {
      if (settled) return
      settled = true
      resolve({ stdout, exitCode })
    })

    // See the function comment: this is what stops `cat > /dev/null` from
    // hanging the pre-flight forever.
    child.stdin.end()
  })
}

/**
 * Design spec §5.5's pre-flight gate check, run once before a run is
 * considered pausable. Spawns `hookPath` directly, twice, and asserts
 * **both** directions:
 *
 * - flag file present  -> deny JSON on stdout, exit 0
 * - flag file absent   -> exit 0, empty stdout
 *
 * One direction is not enough. The real `pause-gate.sh` also emits deny
 * JSON and exits 0 when `AITEAMOS_PAUSE_FLAG` is unset -- its own
 * deliberate loud-misconfiguration path -- so a check that only asserts
 * "flag present => deny" is satisfied by a hook that denies unconditionally,
 * which gates nothing: the run would deny its first tool call regardless of
 * whether pause was ever requested, while looking armed. Asserting the
 * second direction is what proves the hook actually discriminates.
 *
 * What this does **not** prove: that Claude Code will actually invoke the
 * hook. A correct, discriminating script registered under a matcher that
 * never matches, or named in a settings file the CLI never loads, passes
 * this check and still gates nothing. It is a cheap necessary condition on
 * the script itself, not a sufficient one on the wiring around it.
 */
export async function preflightGate(input: {
  readonly hookPath: string
  readonly flagPath: string
}): Promise<void> {
  const { hookPath, flagPath } = input

  const armed = await withFlagFile(flagPath, true, () => runHookScript({ hookPath, flagPath }))
  if (armed.exitCode !== 0 || !isDenyOutput(armed.stdout)) {
    throw new Error(
      `preflightGate: hook at ${hookPath} did not deny with the pause flag present ` +
        `(exit code ${String(armed.exitCode)}, stdout ${JSON.stringify(armed.stdout)}). ` +
        'A working pause gate must deny every tool call while the flag file exists.',
    )
  }

  const disarmed = await withFlagFile(flagPath, false, () => runHookScript({ hookPath, flagPath }))
  if (disarmed.exitCode !== 0 || disarmed.stdout.trim() !== '') {
    throw new Error(
      `preflightGate: hook at ${hookPath} did not allow with the pause flag absent ` +
        `(exit code ${String(disarmed.exitCode)}, stdout ${JSON.stringify(disarmed.stdout)}). ` +
        'A hook that denies with the flag both present and absent gates nothing -- it is not an ' +
        'armed gate, it is a broken run.',
    )
  }
}

async function withFlagFile<T>(flagPath: string, present: boolean, run: () => Promise<T>): Promise<T> {
  if (present) {
    await writeFile(flagPath, '')
  } else {
    await rm(flagPath, { force: true })
  }
  try {
    return await run()
  } finally {
    // Leave no flag file behind: the real flag path this pre-flight checks
    // is the run's own `pauseFlagPath`, which must not already be armed
    // when the run actually starts.
    await rm(flagPath, { force: true })
  }
}
