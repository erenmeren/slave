import { PROVIDER_KINDS, type ProviderKind } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter } from './claude/adapter.js'
import type { SlaveRuntimeAdapter } from './contract/adapter.js'
import { CursorAdapter } from './cursor/adapter.js'
import { parseCursorModels, type ModelOption } from './models.js'

/**
 * Thrown by `AdapterRegistry.resolve` for a kind nothing was configured to serve.
 *
 * Distinguished from a generic `Error` so a caller can tell "this provider was never wired up"
 * apart from any other failure a lookup or a constructor might raise -- and, more to the point,
 * so it is impossible to confuse with success: `buildAdapter()` (retired by this task) always
 * handed back a `ClaudeCodeAdapter`, for every caller, unconditionally, because there was only
 * ever one kind of adapter to build. A registry that resolved an unconfigured kind to the Claude
 * adapter anyway would silently reproduce exactly that -- the class of lie this milestone exists
 * to remove -- so `resolve` throws instead of substituting anything.
 */
export class UnknownProviderError extends Error {
  constructor(public readonly kind: ProviderKind) {
    super(`no adapter is registered for provider kind ${JSON.stringify(kind)}`)
    this.name = 'UnknownProviderError'
  }
}

/**
 * Thrown by `admitAdapter` for an adapter that promises neither pause capability.
 *
 * Its own class for the same reason `UnknownProviderError` is: "this adapter may not be
 * registered" is a different fact from "this kind was never wired up", and a caller assembling a
 * registry from configuration needs to be able to tell them apart.
 */
export class UnregistrableProviderError extends Error {
  constructor(public readonly kind: ProviderKind) {
    super(
      `provider kind ${JSON.stringify(kind)} declares neither canPauseMidRun nor canResumeSession, ` +
        'so a run on it could be started and never paused, cancelled-and-continued, or recovered. ' +
        'Spec §4: a provider with neither capability cannot be registered.',
    )
    this.name = 'UnregistrableProviderError'
  }
}

/**
 * Spec §4's registration rule, enforced rather than described (final review I1): **a provider with
 * neither capability cannot be registered.**
 *
 * The two capabilities are the two ways a run can be stopped and picked up again -- a gate that
 * denies the next tool call (`canPauseMidRun`), or a cancel-and-`--resume` cycle
 * (`canResumeSession`). An adapter with neither can start work that no operator, guardrail or
 * emergency stop can ever suspend and resume: every pause on it becomes a kill with nothing to
 * continue from. Refusing it at BUILD time is the only place the refusal is cheap; by dispatch
 * time there is already a run.
 *
 * Exported (rather than folded into `buildRegistry`) so it can be tested with an adapter that
 * actually has neither capability. Both shipped adapters declare `canResumeSession: true`, so the
 * rule is unreachable through `buildRegistry`'s option shape today -- and an untested rule that
 * first runs on the day a third provider arrives is the rule most likely to be wrong then.
 *
 * M56a R1: it also asserts the adapter IS the kind it is being registered under. The contract's
 * `id: string` became `readonly kind: ProviderKind` precisely so this check could exist -- a plain
 * `Error`, not a named class, because nothing catches it: a table whose entry builds the other
 * vendor's adapter is a wiring bug in this file and is meant to stop the process at build time,
 * where a registry that resolved `'cursor'` to a Claude adapter would be exactly the silent
 * substitution `UnknownProviderError`'s docstring exists to rule out.
 */
export function admitAdapter(kind: ProviderKind, adapter: SlaveRuntimeAdapter): SlaveRuntimeAdapter {
  if (adapter.kind !== kind) {
    throw new Error(
      `adapter registered under ${JSON.stringify(kind)} reports kind ${JSON.stringify(adapter.kind)}: ` +
        'a registry that admitted it would resolve one provider to the other vendor\'s runtime.',
    )
  }
  const capabilities = adapter.getCapabilities()
  if (!capabilities.canPauseMidRun && !capabilities.canResumeSession) throw new UnregistrableProviderError(kind)
  return adapter
}

/**
 * Hands out the one long-lived `SlaveRuntimeAdapter` instance for each provider kind
 * `buildRegistry` was actually given options for.
 *
 * `resolve` is exhaustive over the kinds this particular registry was configured with, not over
 * `ProviderKind` as a whole: a kind with no matching option has no entry at all, and `resolve`
 * refuses it (`UnknownProviderError`) rather than falling back to whichever kind IS configured.
 * Both kinds can be constructed now (M12 Task 12 landed `CursorAdapter`), but a registry built
 * without `cursor` options still refuses `'cursor'` -- what a process was CONFIGURED with, not
 * what the package can build, remains the question `resolve` answers.
 */
export interface AdapterRegistry {
  resolve(kind: ProviderKind): SlaveRuntimeAdapter
}

/**
 * Everything a process has to supply to build ONE provider's adapter (M56a R6).
 *
 * One shape for every provider, rather than two option types a caller has to know apart: the
 * command and its extra argv are per-kind (read from that manifest's `binEnvVar`/`argsEnvVar`), and
 * `scripts` is the SAME object for every entry -- four paths a deployment owns, of which each
 * registration takes the ones its adapter needs. `buildAdapterRegistry` therefore builds one
 * `scripts` and hands it to every kind, which is what makes adding a provider one entry rather than
 * one more option block and two more environment reads.
 */
export interface ProviderWiring {
  readonly command: string
  readonly extraArgs?: readonly string[]
  readonly scripts: {
    /** Claude's `PreToolUse` gate (`scripts/pause-gate.sh`). */
    readonly hookPath: string
    /** Claude's `PostToolUse` tap (`scripts/tool-result-tap.sh`). Optional: a deployment that has
     *  not installed it runs perfectly well without it. */
    readonly tapPath?: string
    /** Cursor's shell gate (`scripts/cursor-shell-gate.sh`). A separate path from `hookPath` on
     *  purpose: the two vendors' gates answer different protocols, and pointing one at the other's
     *  script produces a gate that looks installed and blocks every call, or one that blocks none. */
    readonly gatePath: string
    /** The orchestrator CLI a worker runs to ask the broker for an operation (M52 R3). */
    readonly brokerCliPath?: string
  }
}

/**
 * What this package knows how to build for one kind (M56a R6).
 *
 * `adapterName` is the class's own name, read by the Settings page's adapter card
 * (`apps/web/src/server/settings.ts`) so that surface stops carrying its own copy of the two.
 * `parseModels` is present for a provider whose models are LISTED and absent for one whose models
 * are configured -- `PROVIDER_ADAPTERS`'s own test asserts that correspondence against the manifest
 * rather than leaving it to a reader.
 */
export interface ProviderRegistration {
  readonly adapterName: string
  build(wiring: ProviderWiring): SlaveRuntimeAdapter
  parseModels?(stdout: string): readonly ModelOption[]
}

/**
 * Every adapter this package can build, by kind (M56a R6).
 *
 * A `Record<ProviderKind, …>`, like `PROVIDER_MANIFESTS`, and for the same reason: the two fail
 * TOGETHER. A third kind added to the union is a build error here and there at the same moment, so
 * a registration without a manifest -- an adapter nobody measured -- cannot exist.
 *
 * This is what a new provider ADDS: one entry, a constructor call, and for a `listed` provider a
 * parser. It is not what a new provider WIDENS: `buildRegistry` below is a loop and names no vendor.
 */
export const PROVIDER_ADAPTERS: Record<ProviderKind, ProviderRegistration> = {
  claude_code: {
    adapterName: 'ClaudeCodeAdapter',
    build: (wiring) =>
      new ClaudeCodeAdapter({
        command: wiring.command,
        ...(wiring.extraArgs === undefined ? {} : { extraArgs: wiring.extraArgs }),
        hookPath: wiring.scripts.hookPath,
        ...(wiring.scripts.tapPath === undefined ? {} : { tapPath: wiring.scripts.tapPath }),
        ...(wiring.scripts.brokerCliPath === undefined ? {} : { brokerCliPath: wiring.scripts.brokerCliPath }),
      }),
  },
  cursor: {
    adapterName: 'CursorAdapter',
    build: (wiring) =>
      new CursorAdapter({
        command: wiring.command,
        ...(wiring.extraArgs === undefined ? {} : { extraArgs: wiring.extraArgs }),
        gatePath: wiring.scripts.gatePath,
        ...(wiring.scripts.brokerCliPath === undefined ? {} : { brokerCliPath: wiring.scripts.brokerCliPath }),
      }),
    // The SAME function object `listProviderModels` dispatches to (`models.ts`'s
    // `MODEL_STDOUT_PARSERS`), and `registry.test.ts` pins the two together for every kind. The
    // parser is named from here rather than the other way round because `models.ts` must stay a
    // leaf: it is imported by both adapters, which this module constructs (ruling P12a).
    parseModels: parseCursorModels,
  },
}

/**
 * Builds a registry from the wiring a process was given, once per process
 * (`apps/orchestrator/src/cli.ts`'s `buildAdapterRegistry`) -- the same one call `buildAdapter`
 * used to make before M12 Task 5, just handing back something that can hold more than one kind of
 * adapter instead of exactly one.
 *
 * `Partial<Record<ProviderKind, ProviderWiring>>` (M56a R6) rather than one named optional field per
 * vendor: every entry is still OPTIONAL and none is defaulted, and the rule that made them optional
 * is unchanged -- a deployment that was never given a Cursor gate script must refuse `'cursor'`
 * rather than construct an adapter around a path nobody checked. What a registry resolves remains
 * what a process was CONFIGURED with, not what this package can build.
 */
export function buildRegistry(options: Partial<Record<ProviderKind, ProviderWiring>>): AdapterRegistry {
  const adapters = new Map<ProviderKind, SlaveRuntimeAdapter>()
  for (const kind of PROVIDER_KINDS) {
    const wiring = options[kind]
    if (wiring === undefined) continue
    adapters.set(kind, admitAdapter(kind, PROVIDER_ADAPTERS[kind].build(wiring)))
  }

  return {
    resolve(kind: ProviderKind): SlaveRuntimeAdapter {
      const adapter = adapters.get(kind)
      if (adapter === undefined) throw new UnknownProviderError(kind)
      return adapter
    },
  }
}
