import { ClaudeCodeAdapter, type SlaveRuntimeAdapter, type ClaudeCodeAdapterOptions } from './claude/adapter.js'
import { CursorAdapter, type CursorAdapterOptions } from './cursor/adapter.js'
import type { ProviderKind } from './types.js'

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
 */
export function admitAdapter(kind: ProviderKind, adapter: SlaveRuntimeAdapter): SlaveRuntimeAdapter {
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
 * Builds a registry from adapter construction options, once per process
 * (`apps/orchestrator/src/cli.ts`'s `buildAdapterRegistry`) -- the same one call `buildAdapter`
 * used to make before this task, just handing back something that can hold more than one kind of
 * adapter instead of exactly one.
 *
 * Widened by M12 Task 12 with a second, still OPTIONAL field. Both are optional and neither is
 * defaulted: a deployment that was never given a Cursor gate script must refuse `'cursor'` rather
 * than construct an adapter around a path nobody checked, and an existing caller that passes only
 * `claudeCode` keeps building exactly the registry it built before this field existed.
 */
export function buildRegistry(options: {
  readonly claudeCode?: ClaudeCodeAdapterOptions
  readonly cursor?: CursorAdapterOptions
}): AdapterRegistry {
  const adapters = new Map<ProviderKind, SlaveRuntimeAdapter>()
  if (options.claudeCode !== undefined) {
    adapters.set('claude_code', admitAdapter('claude_code', new ClaudeCodeAdapter(options.claudeCode)))
  }
  if (options.cursor !== undefined) {
    adapters.set('cursor', admitAdapter('cursor', new CursorAdapter(options.cursor)))
  }

  return {
    resolve(kind: ProviderKind): SlaveRuntimeAdapter {
      const adapter = adapters.get(kind)
      if (adapter === undefined) throw new UnknownProviderError(kind)
      return adapter
    },
  }
}
