import { classifyGateEvent, PERMISSION_DENY_REASON_PREFIX } from '@ai-team-os/providers'
import { describe, expect, it } from 'vitest'

describe('classifyGateEvent', () => {
  it('reads a denial as the gate stopping the run', () => {
    expect(classifyGateEvent({ kind: 'hook_denied', hookName: 'pause-gate', reason: 'paused' })).toEqual({
      kind: 'stopped_by_gate',
      reason: 'paused',
    })
  })

  it('reads a hook_denied whose reason carries the matrix prefix as tool_denied, not stopped_by_gate (M18 Task 6)', () => {
    // Both a pause deny and a matrix deny arrive as the identical `hook_denied` shape -- the prefix
    // on `reason` is the only thing that tells them apart, and this is the one place that split
    // happens.
    expect(
      classifyGateEvent({
        kind: 'hook_denied',
        hookName: 'PreToolUse:Bash',
        reason: `${PERMISSION_DENY_REASON_PREFIX} 'run tests' (Bash) for this agent`,
      }),
    ).toEqual({ kind: 'tool_denied', tool: 'Bash', capability: 'run tests' })
  })

  it('falls back to the unknown/unknown payload, never a throw, on a prefixed reason whose tail is malformed', () => {
    expect(
      classifyGateEvent({
        kind: 'hook_denied',
        hookName: 'PreToolUse:Bash',
        reason: `${PERMISSION_DENY_REASON_PREFIX} nonsense`,
      }),
    ).toEqual({ kind: 'tool_denied', tool: 'unknown', capability: 'unknown' })
  })

  it('reads a crashed gate and a failed-open gate as gate failure', () => {
    expect(classifyGateEvent({ kind: 'hook_crashed', hookName: 'g', exitCode: 2, stderr: 'boom' })).toMatchObject({
      kind: 'gate_failed',
    })
    expect(classifyGateEvent({ kind: 'hook_failed_open', hookName: 'g', exitCode: 3, stderr: 'x' })).toMatchObject({
      kind: 'gate_failed',
    })
  })

  it('ignores events that say nothing about the gate', () => {
    expect(classifyGateEvent({ kind: 'text', text: 'hello' })).toBeNull()
  })

  it('does not classify a permission-mode denial as a gate outcome (controller ruling, M12 Task 4)', () => {
    // permission_denied is a guardrail observation, not a pause-protocol signal: it stops nothing
    // and halts nothing (ADR 0001 measured the agent trying another tool), and it carries no
    // `reason` field to source `stopped_by_gate.reason` from. `pump.ts` keeps handling it on its
    // own, outside this function.
    expect(classifyGateEvent({ kind: 'permission_denied', toolName: 'Edit', toolUseId: 'tu_1' })).toBeNull()
  })
})
