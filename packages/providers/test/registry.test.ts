import { PROVIDER_KINDS, manifestFor, type ProviderKind } from '@slave-of-ai/domain'
import { describe, expect, it } from 'vitest'
import type { ProviderCapabilities, SlaveRuntimeAdapter } from '../src/contract/adapter.js'
import { MODEL_STDOUT_PARSERS, PROVIDER_ADAPTERS, admitAdapter, buildRegistry, type ProviderWiring } from '../src/index.js'

/** The wiring a process actually hands a registry: one command and the four script paths, the same
 *  object for every kind (`apps/orchestrator/src/cli.ts`'s `buildAdapterRegistry`). */
const wiring = (command: string): ProviderWiring => ({
  command,
  scripts: {
    hookPath: '/opt/slaveofai/pause-gate.sh',
    gatePath: '/opt/slaveofai/cursor-shell-gate.sh',
    brokerCliPath: '/opt/slaveofai/cli.js',
  },
})

describe('PROVIDER_ADAPTERS (R6)', () => {
  it('has exactly the members of PROVIDER_KINDS, so a registration without a manifest cannot exist', () => {
    expect(Object.keys(PROVIDER_ADAPTERS).sort()).toEqual([...PROVIDER_KINDS].sort())
  })

  it('names the class each entry builds, which is what the Settings card prints', () => {
    expect(PROVIDER_ADAPTERS.claude_code.adapterName).toBe('ClaudeCodeAdapter')
    expect(PROVIDER_ADAPTERS.cursor.adapterName).toBe('CursorAdapter')
  })

  it('gives a parser to exactly the providers whose models are LISTED, and to no others', () => {
    for (const kind of PROVIDER_KINDS) {
      const listed = manifestFor(kind).modelDiscovery.mode === 'listed'
      expect(typeof PROVIDER_ADAPTERS[kind].parseModels === 'function', kind).toBe(listed)
    }
  })

  it('registers the SAME parser `listProviderModels` dispatches to, so the two cannot drift', () => {
    // The fact is the function, named in two places because the registration and the listing reach
    // it from opposite ends of the package (`models.ts` must not import `registry.ts` -- see
    // `MODEL_STDOUT_PARSERS`' own docstring for the cycle that would be). This is what keeps a
    // future `listed` provider from being registered with one parser and read with another.
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_ADAPTERS[kind].parseModels, kind).toBe(MODEL_STDOUT_PARSERS[kind])
    }
  })

  it('builds an adapter that knows which kind it is', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_ADAPTERS[kind].build(wiring('/bin/true')).kind, kind).toBe(kind)
    }
  })
})

describe('buildRegistry (R6)', () => {
  it('resolves a configured kind to its adapter', () => {
    const registry = buildRegistry({ claude_code: wiring('claude') })
    expect(registry.resolve('claude_code').kind).toBe('claude_code')
  })

  it('refuses an unconfigured kind rather than falling back to Claude', () => {
    const registry = buildRegistry({ claude_code: wiring('claude') })
    expect(() => registry.resolve('cursor')).toThrow(/cursor/)
  })

  it('refuses EVERY kind when it was given nothing -- configured, not buildable, is the question', () => {
    const registry = buildRegistry({})
    for (const kind of PROVIDER_KINDS) expect(() => registry.resolve(kind), kind).toThrow(/no adapter is registered/)
  })

  it('builds both shipped adapters, each of which has at least one of the two pause capabilities', () => {
    const registry = buildRegistry({ claude_code: wiring('claude'), cursor: wiring('cursor-agent') })
    expect(registry.resolve('claude_code').kind).toBe('claude_code')
    expect(registry.resolve('cursor').kind).toBe('cursor')
  })

  it('is a map over the union, so adding a provider is an ENTRY and not a widened signature', () => {
    // The shape assertion R6 exists for: every kind can be wired by name, in a loop, with no
    // function signature naming any vendor.
    const everything = Object.fromEntries(PROVIDER_KINDS.map((kind) => [kind, wiring('/bin/true')]))
    const registry = buildRegistry(everything)
    for (const kind of PROVIDER_KINDS) expect(registry.resolve(kind).kind, kind).toBe(kind)
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
 *
 * It is handed the KIND it claims to be (M56a R1): the contract's `id: string` became
 * `readonly kind: ProviderKind`, which cannot hold `'stub'` -- an adapter that does not know which
 * provider it is was never something the registry could admit.
 */
function stubAdapter(kind: ProviderKind, capabilities: ProviderCapabilities): SlaveRuntimeAdapter {
  return {
    kind,
    getCapabilities: (): ProviderCapabilities => capabilities,
    listModels: async () => ({ models: [], source: 'static' as const }),
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
    const useless = stubAdapter('cursor', {
      canPauseMidRun: false,
      canResumeSession: false,
      gate: 'none',
      reportsCost: false,
      reportsToolResults: false,
    })

    expect(() => admitAdapter('cursor', useless)).toThrow(/canPauseMidRun|canResumeSession/)
  })

  it('admits an adapter with either capability alone', () => {
    const gateOnly = stubAdapter('claude_code', {
      canPauseMidRun: true,
      canResumeSession: false,
      gate: 'all-tools',
      reportsCost: true,
      reportsToolResults: true,
    })
    const resumeOnly = stubAdapter('cursor', {
      canPauseMidRun: false,
      canResumeSession: true,
      gate: 'none',
      reportsCost: false,
      reportsToolResults: false,
    })

    expect(admitAdapter('claude_code', gateOnly).kind).toBe('claude_code')
    expect(admitAdapter('cursor', resumeOnly).kind).toBe('cursor')
  })

  it('refuses an adapter that is not the kind it is being registered under (M56a R1)', () => {
    // The contract's own docstring promises "a registry that can assert an adapter is the kind it
    // was registered under" -- this is that assertion. It is unreachable through
    // `PROVIDER_ADAPTERS` today, because each entry constructs the class whose `kind` is its own
    // key; it exists so that the day an entry is copied and one half edited, the registry says so
    // instead of resolving `'cursor'` to a Claude adapter.
    const impostor = stubAdapter('claude_code', {
      canPauseMidRun: false,
      canResumeSession: true,
      gate: 'none',
      reportsCost: false,
      reportsToolResults: false,
    })

    expect(() => admitAdapter('cursor', impostor)).toThrow(/registered under "cursor".*"claude_code"/)
  })
})
