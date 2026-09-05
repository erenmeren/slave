import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
