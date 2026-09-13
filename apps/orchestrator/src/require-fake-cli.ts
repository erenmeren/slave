import { basename } from 'node:path'
import { PROVIDER_KINDS, manifestFor } from '@slave-of-ai/domain'

/**
 * What a process refuses to start with when it was told to use the fake CLI and was not given one,
 * for the variable that failed.
 *
 * One sentence with one hole in it (M56a R10), because the gates, the tests and the message an
 * operator reads must be the same sentence -- and because a refusal that named `SLAVEOFAI_CLAUDE_BIN`
 * when the Cursor variable was the problem would send somebody to fix the wrong line.
 */
export function requireFakeCliRefusal(envVar: string): string {
  return `refusing to start: SLAVEOFAI_REQUIRE_FAKE_CLI is set but ${envVar} is not the fake CLI`
}

/** The historical constant, byte for byte, kept because every gate and two tests name it: it is the
 *  `SLAVEOFAI_CLAUDE_BIN` case of the sentence above. */
export const REQUIRE_FAKE_CLI_REFUSAL = requireFakeCliRefusal('SLAVEOFAI_CLAUDE_BIN')

/**
 * M32 item 7, widened to every registered provider (M56a R10): the caller's own declaration that
 * this process must not reach a vendor account.
 *
 * Every gate and test in this repo that drives a work session drives the FAKE CLI, and the whole
 * of what makes that true is a handful of environment variables the child inherits
 * (`SLAVEOFAI_CLAUDE_BIN`, `SLAVEOFAI_CLAUDE_ARGS`, and now each other provider's own pair). Lose
 * one -- a spawn that forgets to pass the env through, a gate copied from another gate, a `resume`
 * run from a shell that never exported them -- and nothing refuses: `claudeCommand()` falls back to
 * `claude`, the orchestrator spawns the real binary, and the first anybody knows of it is a line on
 * somebody's bill. Setting `SLAVEOFAI_REQUIRE_FAKE_CLI=1` turns that silent fallback into a refusal
 * to start.
 *
 * Takes the environment as an argument rather than reading `process.env`, so the rule is a pure
 * function with a test and not a thing that can only be exercised by spawning a process.
 *
 * THE RULE, now per provider: with the flag set, EVERY kind's `binEnvVar` must be named and must not
 * BE that vendor's real CLI. "Real" is judged by the binary's own name (`claude`, `cursor-agent`, at
 * any path), because that is exactly what the fallback would have spawned and what one of those
 * names on `PATH` is. Everything else passes -- `node` (with the vendor's `*_ARGS` pointing at
 * `packages/providers/test/fake-claude.mjs`) and `scripts/gate-fakes/fake-*.sh` are the shapes this
 * repo actually uses, and inventing a stricter allow-list would refuse the next legitimate fake
 * somebody writes. Both names come from the manifests, so a third provider is covered by the net the
 * day its manifest exists rather than the day somebody remembers this file.
 *
 * WHY THIS IS A REAL CHANGE AND THE ONLY ONE IN THE MILESTONE. Before it, this function read
 * `SLAVEOFAI_CLAUDE_BIN` and nothing else: a CI job with the flag set, the Claude fake wired and no
 * Cursor variable at all would have spawned the REAL `cursor-agent` the moment any code path
 * dispatched a Cursor run. It can only ever turn a silent real spawn into a refusal.
 *
 * Gates that drive the REAL CLIs by design -- `gate-m12-providers`, `gate-m13-runtime`, whose own
 * headers say so -- must not set the flag, and do not. That is still what arms this.
 */
export function fakeCliRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  const required = env['SLAVEOFAI_REQUIRE_FAKE_CLI']
  // Set-but-empty and an explicit "0" are "not asked for": an exported-blank variable must not be
  // able to stop a daemon that nobody meant to constrain.
  if (required === undefined || required === '' || required === '0') return null
  for (const kind of PROVIDER_KINDS) {
    const { binEnvVar, binary } = manifestFor(kind).invocation
    const bin = env[binEnvVar]?.trim()
    if (bin === undefined || bin === '') return requireFakeCliRefusal(binEnvVar)
    if (basename(bin) === binary) return requireFakeCliRefusal(binEnvVar)
  }
  return null
}
