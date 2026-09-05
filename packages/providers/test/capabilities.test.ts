import { describe, expect, it } from 'vitest'
import { capabilitiesOf, ClaudeCodeAdapter, type ProviderKind } from '../src/index.js'

describe('ProviderCapabilities', () => {
  it('exposes exactly the four members the system consumes', () => {
    const caps = new ClaudeCodeAdapter({ command: 'claude', hookPath: '/opt/slaveofai/pause-gate.sh' }).getCapabilities()
    expect(Object.keys(caps).sort()).toEqual([
      'canPauseMidRun',
      'canResumeSession',
      'gate',
      'reportsCost',
    ])
  })

  it('describes the Claude runtime: mid-run pause, resumable, gates every tool, reports cost', () => {
    const caps = new ClaudeCodeAdapter({ command: 'claude', hookPath: '/opt/slaveofai/pause-gate.sh' }).getCapabilities()
    expect(caps).toEqual({
      canPauseMidRun: true,
      canResumeSession: true,
      gate: 'all-tools',
      reportsCost: true,
    })
  })
})

/**
 * `capabilitiesOf` is the ONE capability table (M12 Task 9, controller ruling R2). Both admission
 * points -- write time in `packages/control` and dispatch time in the orchestrator -- have to ask
 * "does kind K report cost?" and neither can construct an adapter to ask: `packages/control` has
 * no registry, and write time has no run. So the table is a pure lookup on the kind, and the
 * adapter's own `getCapabilities()` delegates to it rather than holding a second copy.
 */
describe('capabilitiesOf', () => {
  it('is the same table the Claude adapter itself answers from -- not a second copy', () => {
    // Identity, not equality: two frozen objects that happen to agree today would satisfy
    // `toEqual` and still drift apart on the first edit to either one, which is exactly the
    // failure this ruling exists to prevent.
    const adapter = new ClaudeCodeAdapter({ command: 'claude', hookPath: '/opt/slaveofai/pause-gate.sh' })
    expect(adapter.getCapabilities()).toBe(capabilitiesOf('claude_code'))
  })

  it('describes the Cursor runtime: no mid-run pause, resumable, gates every tool, cost-blind', () => {
    expect(capabilitiesOf('cursor')).toEqual({
      canPauseMidRun: false,
      canResumeSession: true,
      gate: 'all-tools',
      reportsCost: false,
    })
  })

  it('answers for every ProviderKind, so a cost question can never go unanswered', () => {
    // The budget admission asks this of whatever kind a chain resolved to. A kind with no row
    // would hand it `undefined` and it would throw reading `.reportsCost` instead of refusing --
    // hence the never-binding default in the switch, which turns a missing row into a BUILD
    // failure. This test is the runtime half of the same claim.
    const kinds: readonly ProviderKind[] = ['claude_code', 'cursor']
    for (const kind of kinds) {
      expect(typeof capabilitiesOf(kind).reportsCost).toBe('boolean')
      expect(Object.keys(capabilitiesOf(kind)).sort()).toEqual(['canPauseMidRun', 'canResumeSession', 'gate', 'reportsCost'])
    }
  })
})
