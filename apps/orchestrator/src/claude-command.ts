import { fakeCliRefusal } from './require-fake-cli.js'

/**
 * The `claude` binary a caller should spawn, and any extra argv in front of its own flags. Pure
 * (M34 t3, extracted from `cli.ts`'s `claudeCommand()`): takes the environment as an argument
 * rather than reading `process.env`, so the fallback to the real `claude` binary -- the thing
 * `SLAVEOFAI_REQUIRE_FAKE_CLI` exists to catch -- has a test of its own (`claude-command.test.ts`)
 * instead of only ever being exercised by a subprocess in `cli.test.ts`.
 *
 * M32 item 7: the one place that decides what gets spawned is the one place that can refuse. A
 * caller that set `SLAVEOFAI_REQUIRE_FAKE_CLI` (every gate that drives the fake CLI, and CI
 * job-wide) has said this process must not reach a vendor account; without the check the fallback
 * below silently spawns the real `claude` the moment `SLAVEOFAI_CLAUDE_BIN` goes missing. Thrown,
 * not returned: `cli.ts`'s thin wrapper passes `process.env` straight through, so the throw
 * propagates from the same call site it always has, and `main`'s own catch turns it into a message
 * and exit 1.
 */
export function claudeCommandFrom(env: NodeJS.ProcessEnv): { readonly command: string; readonly extraArgs?: readonly string[] } {
  const refusal = fakeCliRefusal(env)
  if (refusal !== null) throw new Error(refusal)
  const command = env['SLAVEOFAI_CLAUDE_BIN'] ?? 'claude'
  const extra = env['SLAVEOFAI_CLAUDE_ARGS']
  return { command, ...(extra === undefined || extra === '' ? {} : { extraArgs: extra.split(' ') }) }
}
