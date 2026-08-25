import { describe, expect, it } from 'vitest'
import { classifyGateEvent } from '@ai-team-os/providers'

describe('classifyGateEvent', () => {
  it('reads a denial as the gate stopping the run', () => {
    expect(classifyGateEvent({ kind: 'hook_denied', hookName: 'pause-gate', reason: 'paused' })).toEqual({
      kind: 'stopped_by_gate',
      reason: 'paused',
    })
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
