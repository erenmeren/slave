import { describe, expect, it } from 'vitest'
import type { AgentRuntimeAdapter, ProviderCapabilities } from '../src/claude/adapter.js'
import { admitAdapter, buildRegistry } from '../src/index.js'

describe('buildRegistry', () => {
  it('resolves a configured kind to its adapter', () => {
    const registry = buildRegistry({ claudeCode: { command: 'claude', hookPath: '/tmp/g.sh' } })
    expect(registry.resolve('claude_code').id).toBe('claude-code')
  })

  it('refuses an unconfigured kind rather than falling back to Claude', () => {
    const registry = buildRegistry({ claudeCode: { command: 'claude', hookPath: '/tmp/g.sh' } })
    expect(() => registry.resolve('cursor')).toThrow(/cursor/)
  })

  it('builds both shipped adapters, each of which has at least one of the two pause capabilities', () => {
    const registry = buildRegistry({
      claudeCode: { command: 'claude', hookPath: '/tmp/g.sh' },
      cursor: { command: 'cursor-agent', gatePath: '/tmp/shell-gate.sh' },
    })
    expect(registry.resolve('claude_code').id).toBe('claude-code')
    expect(registry.resolve('cursor').id).toBe('cursor')
  })
})

/**
 * Spec §4's registration rule -- "a provider with neither capability cannot be registered" --
 * tested through `admitAdapter`, the guard `buildRegistry` runs over every adapter it constructs.
 *
 * A STUB, not one of the shipped adapters: both real ones declare `canResumeSession: true`, so the
 * refusal is unreachable through `buildRegistry`'s own option shape today and would be untested
 * until the day a third provider needed it -- which is the day it must already work. Nothing is
 * mocked; the stub simply IS an adapter that promises neither capability.
 */
function stubAdapter(capabilities: ProviderCapabilities): AgentRuntimeAdapter {
  return {
    id: 'stub',
    getCapabilities: (): ProviderCapabilities => capabilities,
    start: (): never => {
      throw new Error('stubAdapter: nothing here is meant to run')
    },
    events: (): never => {
      throw new Error('stubAdapter: nothing here is meant to run')
    },
    cancel: (): never => {
      throw new Error('stubAdapter: nothing here is meant to run')
    },
    resume: (): never => {
      throw new Error('stubAdapter: nothing here is meant to run')
    },
  }
}

describe('admitAdapter', () => {
  it('refuses an adapter that can neither pause mid-run nor resume a session', () => {
    const useless = stubAdapter({
      canPauseMidRun: false,
      canResumeSession: false,
      gate: 'none',
      reportsCost: false,
    })

    expect(() => admitAdapter('cursor', useless)).toThrow(/canPauseMidRun|canResumeSession/)
  })

  it('admits an adapter with either capability alone', () => {
    const gateOnly = stubAdapter({ canPauseMidRun: true, canResumeSession: false, gate: 'all-tools', reportsCost: true })
    const resumeOnly = stubAdapter({ canPauseMidRun: false, canResumeSession: true, gate: 'none', reportsCost: false })

    expect(admitAdapter('claude_code', gateOnly).id).toBe('stub')
    expect(admitAdapter('cursor', resumeOnly).id).toBe('stub')
  })
})
