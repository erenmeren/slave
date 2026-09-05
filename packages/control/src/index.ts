export * from './paths.js'
export * from './kill.js'
export * from './refusal.js'
export * from './budget.js'
export * from './runtime.js'

/**
 * Re-exported so `apps/web` can NAME the runtime it renders (M12 Task 9, ruling R10). The web app
 * depends on `@slave-of-ai/control` but not on `@slave-of-ai/providers`, and `AgentRun.provider` now
 * reaches the Overview as real data rather than a hardcoded string -- so the surface needs the
 * type. Re-exporting here is a strictly smaller change than adding a dependency edge from the web
 * app to the providers package, which it otherwise has no business importing from: it must never
 * construct an adapter.
 *
 * Note the spelling, which is a real trap on this seam: `'claude_code'` is the `ProviderKind`
 * (the Postgres enum, the column, this type); `'claude-code'` is the ADAPTER ID
 * (`ClaudeCodeAdapter.id`), which is what `overview.ts` used to hardcode.
 */
export type { ProviderKind } from '@slave-of-ai/providers'
/**
 * Re-exported alongside `ProviderKind` for the same reason (M12 Task 13): the roster's data
 * loader (`apps/web/src/server/org.ts`) needs the shell-only gate mark for a worker's resolved
 * provider, and `capabilitiesOf` -- the one capability table (see this function's own docstring
 * in `@slave-of-ai/providers`) -- is a pure lookup on a `ProviderKind` alone, not an adapter
 * construction. Re-exporting it here keeps the web app off the providers package the same way the
 * type re-export above does, rather than growing a second table of the same facts in `apps/web`.
 */
export { capabilitiesOf } from '@slave-of-ai/providers'
export type { ProviderCapabilities } from '@slave-of-ai/providers'
/** Re-exported for the same reason as `capabilitiesOf` (M25 §5.2): `apps/web/src/server/models.ts`
 *  asks "which models can this provider run" by KIND, which spawns the provider's CLI but never
 *  constructs an adapter. */
export { listProviderModels } from '@slave-of-ai/providers'
export type { ModelListing, ModelOption } from '@slave-of-ai/providers'
/**
 * Re-exported for the same reason as capabilitiesOf above (M12 Task 13 fix round 1): a SERVER
 * caller that needs every ProviderKind as data (packages/control/src/org.ts's own
 * isProviderKind is exactly this shape of caller) should reach the one canonical,
 * compile-time-guarded list rather than hand-roll another. NOT safe to value-import into a
 * CLIENT component through this barrel -- see PROVIDER_KINDS's docstring in
 * @slave-of-ai/providers/src/types.ts for why, and apps/web/src/components/ProviderSelect.tsx
 * for the client-safe mirror that exists because of it.
 */
export { PROVIDER_KINDS } from '@slave-of-ai/providers'
export * from './pause.js'
export * from './stop.js'
export * from './emergency.js'
export * from './resume.js'
export * from './dependency.js'
export * from './goal.js'
export * from './workspace.js'
export * from './org.js'
export * from './skills.js'
export * from './permission.js'
export * from './principal.js'
export * from './git-probe.js'
export * from './git.js'
export * from './collect.js'
export * from './password.js'
export * from './users.js'
