import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { preflightGate as runPreflight } from '../runtime/gate-preflight.js'

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

/**
 * Design spec §5.5's pre-flight gate check for Claude Code, run once before a run is considered
 * pausable. The probe itself -- spawning the script twice, arming and disarming an isolated
 * temporary flag file, asserting both directions -- lives in `runtime/gate-preflight.ts` and is
 * shared with Cursor; the only thing that is Claude's alone is how an allow is spelled.
 *
 * Claude's allow is SILENCE (ADR 0001 §5.3): exit 0, empty stdout. That is the whole difference
 * from Cursor's contract, and it is why `expectAllow` exists on the shared probe at all.
 */
export async function preflightGate(input: { readonly hookPath: string }): Promise<void> {
  return runPreflight({
    hookPath: input.hookPath,
    label: 'preflightGate',
    noun: 'hook',
    deniedBy: isDenyOutput,
    expectAllow: { kind: 'silent' },
  })
}
