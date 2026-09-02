import { describe, expect, it } from 'vitest'
import { classifyGateEvent, PERMISSION_DENY_REASON_PREFIX, parsePermissionDenyReason } from '../src/gate.js'

/**
 * `parsePermissionDenyReason` (M18 Task 6): the fixed grammar every matrix deny reason follows,
 * `permission matrix denies '<capability>' (<tool>) for this agent` (scripts/lib/permissions.sh),
 * parsed into `{ tool, capability }` -- or `null` on anything that does not match. It is total: it
 * must never throw, for any string, because `classifyGateEvent` calls it on whatever arrived on
 * the wire, not on what the shell twin is trusted to send.
 */
describe('parsePermissionDenyReason', () => {
  it('parses the fixed grammar into tool and capability', () => {
    expect(parsePermissionDenyReason(`${PERMISSION_DENY_REASON_PREFIX} 'run tests' (Bash) for this agent`)).toEqual({
      tool: 'Bash',
      capability: 'run tests',
    })
  })

  it('returns null for a reason that does not carry the grammar at all -- an ordinary pause reason', () => {
    expect(parsePermissionDenyReason('Paused by AI Team OS. Stop and wait.')).toBeNull()
  })

  it('returns null, never throws, on a reason that starts with the prefix but is malformed past it', () => {
    // Missing the quotes around the capability.
    expect(parsePermissionDenyReason(`${PERMISSION_DENY_REASON_PREFIX} run tests (Bash) for this agent`)).toBeNull()
    // The prefix alone, nothing past it.
    expect(parsePermissionDenyReason(PERMISSION_DENY_REASON_PREFIX)).toBeNull()
    // The empty string.
    expect(parsePermissionDenyReason('')).toBeNull()
  })

  it('does not crash on a capability containing a quote of its own -- capabilities are fixed strings today, but this parses whatever arrives, not what the shell script promises to send', () => {
    const reason = `${PERMISSION_DENY_REASON_PREFIX} 'run 'tests'' (Bash) for this agent`
    expect(() => parsePermissionDenyReason(reason)).not.toThrow()
    // The greedy capture lands on the LAST `' (` in the string -- a documented consequence of the
    // parser's own regex, not a promise to round-trip an embedded quote. The only promise here is
    // "never throws", which the assertion above already proves; this pins the concrete (harmless)
    // behaviour so a future change to the regex is visible rather than silently drifting.
    expect(parsePermissionDenyReason(reason)).toEqual({ tool: 'Bash', capability: "run 'tests'" })
  })
})

describe('classifyGateEvent threads hookId (M21 C1, pinned in M22)', () => {
  const matrixReason = "permission matrix denies 'run tests' (Bash) for this agent"
  it('carries hookId on tool_denied when the deny had one', () => {
    const outcome = classifyGateEvent({ kind: 'hook_denied', hookName: 'PreToolUse:Bash', reason: matrixReason, hookId: 'hk-1' })
    expect(outcome).toEqual({ kind: 'tool_denied', tool: 'Bash', capability: 'run tests', hookId: 'hk-1' })
  })
  it('leaves the key absent when the deny had none', () => {
    const outcome = classifyGateEvent({ kind: 'hook_denied', hookName: 'PreToolUse:Bash', reason: matrixReason })
    expect(outcome).not.toBeNull()
    expect(outcome !== null && 'hookId' in outcome).toBe(false)
  })
  it('never puts hookId on a pause deny (stopped_by_gate)', () => {
    const outcome = classifyGateEvent({ kind: 'hook_denied', hookName: 'PreToolUse:Bash', reason: 'paused by the operator', hookId: 'hk-1' })
    expect(outcome?.kind).toBe('stopped_by_gate')
    expect(outcome !== null && 'hookId' in outcome).toBe(false)
  })
})
