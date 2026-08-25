import type { AdapterRegistry, AgentRuntimeAdapter, ProviderKind } from '@ai-team-os/providers'

/**
 * The provider every run resolves to today. M12 Task 8 replaces this with a lookup against the
 * run's own persisted provider once a second runtime is real dispatch, not a stub -- until then
 * this is the one line every `AdapterRegistry.resolve` call in the orchestrator goes through, so
 * Task 8 has exactly one line to change.
 *
 * A separate constant from `packages/control/src/pause.ts`'s own `CURRENT_PROVIDER_KIND`, not a
 * shared one, though it follows the same M12 controller ruling and names the same fact: that
 * function's `signalPause` is a stateless cross-process dispatch on `kind` with no adapter
 * instance involved, while this one resolves a live `AgentRuntimeAdapter` out of an
 * `AdapterRegistry` -- different call shapes, in different packages (`packages/control` does not
 * depend on `apps/orchestrator`, nor should it), that happen to need the same single literal
 * until Task 8 makes both real lookups.
 */
const CURRENT_PROVIDER_KIND: ProviderKind = 'claude_code'

/** The one place every `deps.adapter.x(...)` call site in the orchestrator resolves its adapter. */
export function resolveAdapter(registry: AdapterRegistry): AgentRuntimeAdapter {
  return registry.resolve(CURRENT_PROVIDER_KIND)
}
