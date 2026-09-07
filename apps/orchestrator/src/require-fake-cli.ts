import { basename } from 'node:path'

/**
 * What a process refuses to start with when it was told to use the fake CLI and was not given one.
 * One constant, because the gates, the tests and the message an operator reads must be the same
 * sentence.
 */
export const REQUIRE_FAKE_CLI_REFUSAL = 'refusing to start: SLAVEOFAI_REQUIRE_FAKE_CLI is set but SLAVEOFAI_CLAUDE_BIN is not the fake CLI'

/**
 * M32 item 7: the caller's own declaration that this process must not reach a vendor account.
 *
 * Every gate and test in this repo that drives a work session drives the FAKE CLI, and the whole
 * of what makes that true is two environment variables the child inherits
 * (`SLAVEOFAI_CLAUDE_BIN`, `SLAVEOFAI_CLAUDE_ARGS`). Lose one -- a spawn that forgets to pass the
 * env through, a gate copied from another gate, a `resume` run from a shell that never exported
 * them -- and nothing refuses: `claudeCommand()` falls back to `claude`, the orchestrator spawns
 * the real binary, and the first anybody knows of it is a line on somebody's bill. Setting
 * `SLAVEOFAI_REQUIRE_FAKE_CLI=1` turns that silent fallback into a refusal to start.
 *
 * The rule: with the flag set, `SLAVEOFAI_CLAUDE_BIN` must be named and must not BE the real CLI.
 * "Real" is judged by the binary's own name (`claude`, at any path), because that is exactly what
 * the fallback would have spawned and what a `claude` on `PATH` is. Everything else passes --
 * `node` (with `SLAVEOFAI_CLAUDE_ARGS` pointing at `packages/providers/test/fake-claude.mjs`) and
 * `scripts/gate-fakes/fake-claude.sh` are the two shapes this repo actually uses, and inventing a
 * stricter allow-list would refuse the next legitimate fake somebody writes.
 *
 * Takes the environment as an argument rather than reading `process.env`, so the rule is a pure
 * function with a test and not a thing that can only be exercised by spawning a process.
 *
 * Gates that drive the REAL CLI by design -- `gate-m12-providers`, `gate-m13-runtime`, whose own
 * headers say so -- must not set the flag, and do not.
 */
export function fakeCliRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  const required = env['SLAVEOFAI_REQUIRE_FAKE_CLI']
  // Set-but-empty and an explicit "0" are "not asked for": an exported-blank variable must not be
  // able to stop a daemon that nobody meant to constrain.
  if (required === undefined || required === '' || required === '0') return null
  const bin = env['SLAVEOFAI_CLAUDE_BIN']?.trim()
  if (bin === undefined || bin === '') return REQUIRE_FAKE_CLI_REFUSAL
  return basename(bin) === 'claude' ? REQUIRE_FAKE_CLI_REFUSAL : null
}
