import { describe, expect, it } from 'vitest'
import { REQUIRE_FAKE_CLI_REFUSAL } from '../src/require-fake-cli.js'
import { claudeCommandFrom } from '../src/claude-command.js'

/**
 * M34 t3: `claudeCommand()`'s pure part (`cli.ts:299`), extracted so the fallback to the real
 * `claude` binary -- the thing `SLAVEOFAI_REQUIRE_FAKE_CLI` exists to catch -- has a test of its
 * own rather than only ever being exercised by a subprocess in `cli.test.ts`.
 */
describe('claudeCommandFrom', () => {
  it('falls back to the real claude binary, with no extra args, when SLAVEOFAI_CLAUDE_BIN is unset', () => {
    expect(claudeCommandFrom({})).toEqual({ command: 'claude' })
  })

  it('reads SLAVEOFAI_CLAUDE_BIN and splits SLAVEOFAI_CLAUDE_ARGS on spaces', () => {
    expect(claudeCommandFrom({ SLAVEOFAI_CLAUDE_BIN: 'node', SLAVEOFAI_CLAUDE_ARGS: '/repo/fake-claude.mjs --fixture m8-flow' })).toEqual({
      command: 'node',
      extraArgs: ['/repo/fake-claude.mjs', '--fixture', 'm8-flow'],
    })
  })

  it('refuses the silent fallback when SLAVEOFAI_REQUIRE_FAKE_CLI is set and no binary is named -- the same refusal require-fake-cli.test.ts asserts', () => {
    expect(() => claudeCommandFrom({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1' })).toThrow(REQUIRE_FAKE_CLI_REFUSAL)
  })
})
