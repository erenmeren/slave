import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export interface GateRunResult {
  readonly stdout: string
  readonly exitCode: number | null
}

/**
 * Spawns the gate script directly (never through a vendor CLI) with `SLAVEOFAI_PAUSE_FLAG` pointing
 * at `flagPath`, having first created or removed the flag file itself.
 *
 * Both gate scripts open with `cat > /dev/null`, draining what the real CLI would have piped in as
 * the hook payload. Spawned from Node with piped stdio, nothing ever ends that pipe, so the drain
 * would block forever and the probe would hang rather than pass or fail -- `stdin.end()` below is
 * the EOF a real invocation would have supplied.
 */
export async function runGateScript(input: {
  readonly hookPath: string
  readonly flagPath: string
  readonly flagPresent: boolean
}): Promise<GateRunResult> {
  if (input.flagPresent) {
    await writeFile(input.flagPath, '')
  } else {
    await rm(input.flagPath, { force: true })
  }

  return new Promise<GateRunResult>((resolve, reject) => {
    const child = spawn(input.hookPath, [], {
      env: { ...process.env, SLAVEOFAI_PAUSE_FLAG: input.flagPath },
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
    // Drained, not asserted on: a real failure path (exit 2) reports its reason on stderr for the
    // vendor CLI, not for this probe, whose verdict is stdout shape plus exit code.
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

/**
 * How the runtime spells an allow, and the whole reason this function is parameterized at all.
 *
 * Claude's gate allows by staying SILENT. Cursor's must speak: it classifies exit 0 with empty
 * stdout as a hook FAILURE (`empty_stdout`), which `failClosed: true` converts into a block, so a
 * silent Cursor gate would block every tool call of every run while looking correctly installed.
 */
export type AllowContract =
  | { readonly kind: 'silent' }
  | { readonly kind: 'explicit'; readonly allowedBy: (stdout: string) => boolean; readonly hint: string }

/**
 * Design spec §5.5's pre-flight gate check, run once before a run is considered pausable. Spawns
 * the script directly, twice, and asserts BOTH directions:
 *
 * - flag file present -> the runtime's deny shape, exit 0
 * - flag file absent  -> the runtime's allow shape, exit 0
 *
 * One direction is not enough. Both gate scripts also deny when `SLAVEOFAI_PAUSE_FLAG` is unset --
 * their deliberate loud-misconfiguration path -- so a check that only asserts "flag present =>
 * deny" is satisfied by a script that denies unconditionally, which gates nothing: the run would
 * refuse its first tool call regardless of whether pause was ever requested, while looking armed.
 * Asserting the second direction is what proves the script discriminates.
 *
 * `flagPath` is deliberately NOT a parameter. This check arms and disarms a flag file to probe the
 * script, and a caller-supplied path would make it possible -- by accident -- to point that at a
 * live run's own `pauseFlagPath`, silently disarming that run's gate mid-flight. Minting an
 * isolated temporary flag file internally, in its own directory removed afterward regardless of
 * outcome, makes that mistake impossible to make rather than just documented against.
 *
 * What this does NOT prove: that the vendor CLI will actually invoke the script. A correct,
 * discriminating gate registered under a matcher that never matches, or named in a settings file
 * the CLI never loads, passes this check and still gates nothing. It is a cheap necessary condition
 * on the script itself, not a sufficient one on the wiring around it.
 */
export async function preflightGate(input: {
  readonly hookPath: string
  /** Opens both error messages: `'preflightGate'` or `'cursorPreflightGate'`. */
  readonly label: string
  /** What the message calls the script: `'hook'` or `'gate'`. */
  readonly noun: string
  readonly deniedBy: (stdout: string) => boolean
  readonly expectAllow: AllowContract
}): Promise<void> {
  const { hookPath, label, noun } = input
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-preflight-'))
  const flagPath = join(dir, 'pause.flag')

  try {
    const armed = await runGateScript({ hookPath, flagPath, flagPresent: true })
    if (armed.exitCode !== 0 || !input.deniedBy(armed.stdout)) {
      throw new Error(
        `${label}: ${noun} at ${hookPath} did not deny with the pause flag present ` +
          `(exit code ${String(armed.exitCode)}, stdout ${JSON.stringify(armed.stdout)}). ` +
          'A working pause gate must deny every tool call while the flag file exists.',
      )
    }

    const disarmed = await runGateScript({ hookPath, flagPath, flagPresent: false })
    const allowed =
      input.expectAllow.kind === 'silent'
        ? disarmed.stdout.trim() === ''
        : input.expectAllow.allowedBy(disarmed.stdout)
    if (disarmed.exitCode !== 0 || !allowed) {
      throw new Error(
        `${label}: ${noun} at ${hookPath} did not allow with the pause flag absent ` +
          `(exit code ${String(disarmed.exitCode)}, stdout ${JSON.stringify(disarmed.stdout)}). ` +
          'A hook that denies with the flag both present and absent gates nothing -- it is not an ' +
          'armed gate, it is a broken run.' +
          (input.expectAllow.kind === 'explicit' ? input.expectAllow.hint : ''),
      )
    }
  } finally {
    // The whole temporary directory, not just the flag file: this is the only thing this check
    // ever created, so removing it leaves nothing behind regardless of which branch above ran or
    // threw.
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * The four fields one tap line must carry, and the only thing {@link preflightTap} reads back.
 * Identical to `RuntimeEvent`'s `tool_result` arm by construction -- the tap is a second producer
 * of exactly that event -- but written here as a shape check on a LINE rather than imported as a
 * type, because what is being asserted is that a shell script's output parses, not that a value
 * this process constructed has the right type.
 */
const TAP_LINE_FIELDS = ['toolUseId', 'toolName', 'outcome', 'errorClass'] as const

/**
 * The tap's own pre-flight (M51 R6, plan erratum E11).
 *
 * {@link preflightGate} cannot do this job: it arms and disarms a pause flag and asserts BOTH
 * directions, and a tap has no directions -- it never denies, so the armed half fails by
 * construction. What CAN be asserted about a tap is exactly three things, and all three are
 * necessary conditions a broken install fails:
 *
 *   - **exit 0.** A PostToolUse hook that exits non-zero interferes with the run it is watching.
 *   - **empty stdout.** The CLI parses a hook's stdout as a hook response. A tap that speaks can
 *     change a run, which is the one thing a tap must never do.
 *   - **exactly one parseable line, with the four fields.** A tap that records nothing is not
 *     installed, and this is the half that a path typo, a missing `node` and a non-executable bit
 *     all fail at.
 *
 * What this does NOT prove, said out loud the way {@link preflightGate}'s docstring says its own:
 * that the CLI will actually invoke the script. A correct tap registered under a matcher that never
 * matches passes this and records nothing. That is what R6's MEASUREMENT is for.
 *
 * The results file is minted inside a `mkdtemp` directory removed in a `finally`, and there is
 * deliberately no path parameter -- `preflightGate`'s isolation discipline, for its reason: a
 * caller-supplied path could be pointed, by accident, at a LIVE run's own `tool-results.ndjson`,
 * and this check would then append a synthetic result to a real run's evidence.
 */
export async function preflightTap(input: { readonly tapPath: string }): Promise<void> {
  const { tapPath } = input
  if (!isAbsolute(tapPath)) {
    throw new Error(`preflightTap: tapPath must be absolute, got ${JSON.stringify(tapPath)}`)
  }
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-tap-preflight-'))
  const resultsPath = join(dir, 'tool-results.ndjson')
  try {
    const result = await runTapScript({ tapPath, resultsPath })
    if (result.exitCode !== 0) {
      throw new Error(
        `preflightTap: tap at ${tapPath} exited ${String(result.exitCode)} on a synthetic PostToolUse ` +
          'payload. A PostToolUse hook that exits non-zero interferes with the run it is watching; ' +
          'a tap must exit 0 on every path, including its own failures.',
      )
    }
    if (result.stdout !== '') {
      throw new Error(
        `preflightTap: tap at ${tapPath} wrote ${JSON.stringify(result.stdout)} to stdout. The CLI ` +
          'parses a hook\'s stdout as a hook response, so a tap that speaks can change a run -- ' +
          'diagnostics belong on stderr.',
      )
    }
    let written = ''
    try {
      written = await readFile(resultsPath, 'utf8')
    } catch {
      written = ''
    }
    const lines = written.split('\n').filter((line) => line !== '')
    if (lines.length !== 1) {
      throw new Error(
        `preflightTap: tap at ${tapPath} wrote no line (or more than one: ${String(lines.length)}) for one ` +
          'synthetic call. A tap that records nothing is not installed -- check the path, its exec ' +
          'bit, and that `node` is on the PATH the runtime spawns hooks with.',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[0] ?? '')
    } catch {
      throw new Error(
        `preflightTap: tap at ${tapPath} wrote a line that is not JSON. The adapter's tailer reads this ` +
          'file line by line and would drop every result the run produced.',
      )
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`preflightTap: tap at ${tapPath} wrote a line that is not a JSON object.`)
    }
    const missing = TAP_LINE_FIELDS.filter((field) => !(field in (parsed as Record<string, unknown>)))
    if (missing.length > 0) {
      throw new Error(
        `preflightTap: tap at ${tapPath} wrote a line missing ${missing.join(', ')}. All four fields are ` +
          'what a `tool_result` event is made of; a line short of one pairs with nothing.',
      )
    }
  } finally {
    // The whole temporary directory, for `preflightGate`'s reason: it is the only thing this check
    // ever created, so removing it leaves nothing behind regardless of which branch above threw.
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Spawns the tap once with a synthetic PostToolUse payload on stdin and `SLAVEOFAI_TOOL_RESULTS`
 * pointed at `resultsPath`. The sibling of {@link runGateScript}, and it ends stdin for the same
 * reason: the tap reads its payload whole, and nothing else would ever close that pipe.
 */
function runTapScript(input: {
  readonly tapPath: string
  readonly resultsPath: string
}): Promise<{ readonly stdout: string; readonly exitCode: number | null }> {
  const payload = JSON.stringify({
    tool_use_id: 'preflight',
    tool_name: 'Preflight',
    tool_response: { is_error: false },
  })
  return new Promise((resolve, reject) => {
    const child = spawn(input.tapPath, [], {
      env: { ...process.env, SLAVEOFAI_TOOL_RESULTS: input.resultsPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    // Drained, not asserted on: a tap reports its own failures on stderr by design, and this probe's
    // verdict is stdout shape, exit code, and the line it wrote.
    child.stderr.resume()

    child.once('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('close', (exitCode: number | null) => {
      if (settled) return
      settled = true
      resolve({ stdout, exitCode })
    })

    child.stdin.end(payload)
  })
}
