import { describe, expect, it } from 'vitest'
import { fakeCliRefusal, REQUIRE_FAKE_CLI_REFUSAL } from '../src/require-fake-cli.js'

/**
 * M32 item 7. Every gate and test in this repo that drives a work session is meant to drive the
 * FAKE CLI, and the wiring that makes that true is two environment variables the child inherits.
 * If one of them is missing, nothing refuses: the orchestrator spawns `claude` and the run is
 * billed to somebody's real account. `SLAVEOFAI_REQUIRE_FAKE_CLI=1` is the caller saying "this
 * process must not reach a vendor account", and this is the check that makes the saying binding.
 */
describe('fakeCliRefusal', () => {
  it('says nothing when the flag is not set, whatever the binary is', () => {
    expect(fakeCliRefusal({})).toBeNull()
    expect(fakeCliRefusal({ SLAVEOFAI_CLAUDE_BIN: 'claude' })).toBeNull()
    // Set-but-empty and an explicit "0" are both "not asked for": an env var that exists because
    // something exported it blank must not turn into a refusal to start.
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '' })).toBeNull()
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '0' })).toBeNull()
  })

  it('refuses when the flag is set and no binary is named -- the default IS the real claude', () => {
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1' })).toBe(REQUIRE_FAKE_CLI_REFUSAL)
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: '  ' })).toBe(REQUIRE_FAKE_CLI_REFUSAL)
  })

  it('refuses a binary that resolves to a real claude, by name or by path', () => {
    for (const bin of ['claude', '/usr/local/bin/claude', './claude', '  claude  ']) {
      expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: bin })).toBe(REQUIRE_FAKE_CLI_REFUSAL)
    }
  })

  it('allows the two shapes every fake in this repo actually takes', () => {
    // `node <fake-claude.mjs> --fixture <name>` (the gates' and cli.test.ts's own wiring)...
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: 'node', SLAVEOFAI_CLAUDE_ARGS: '/repo/packages/providers/test/fake-claude.mjs --fixture m8-flow' })).toBeNull()
    // ...and the executable script CI points at.
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: '/repo/scripts/gate-fakes/fake-claude.sh' })).toBeNull()
  })

  it('names both variables in the refusal, so the fix is readable from the message alone', () => {
    expect(REQUIRE_FAKE_CLI_REFUSAL).toBe('refusing to start: SLAVEOFAI_REQUIRE_FAKE_CLI is set but SLAVEOFAI_CLAUDE_BIN is not the fake CLI')
  })
})
