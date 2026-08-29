import { ClaudeCodeAdapter, type AgentRuntimeAdapter, type ClaudeCodeAdapterOptions } from './claude/adapter.js'
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
 * Hands out the one long-lived `AgentRuntimeAdapter` instance for each provider kind
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
  resolve(kind: ProviderKind): AgentRuntimeAdapter
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
  const adapters = new Map<ProviderKind, AgentRuntimeAdapter>()
  if (options.claudeCode !== undefined) {
    adapters.set('claude_code', new ClaudeCodeAdapter(options.claudeCode))
  }
  if (options.cursor !== undefined) {
    adapters.set('cursor', new CursorAdapter(options.cursor))
  }

  return {
    resolve(kind: ProviderKind): AgentRuntimeAdapter {
      const adapter = adapters.get(kind)
      if (adapter === undefined) throw new UnknownProviderError(kind)
      return adapter
    },
  }
}
