export * from './paths.js'
export * from './installation.js'
export * from './kill.js'
export * from './refusal.js'
export * from './plural.js'
export * from './budget.js'
export * from './runtime.js'

/**
 * Re-exported so `apps/web` can NAME the runtime it renders (M12 Task 9, ruling R10). The web app
 * depends on `@slave-of-ai/control` but not on `@slave-of-ai/providers`, and `SlaveRun.provider` now
 * reaches the Overview as real data rather than a hardcoded string -- so the surface needs the
 * type. Re-exporting here is a strictly smaller change than adding a dependency edge from the web
 * app to the providers package, which it otherwise has no business importing from: it must never
 * construct an adapter.
 *
 * One spelling on this seam since M56a R1: an adapter's `kind` is a `ProviderKind`
 * (`ClaudeCodeAdapter.kind` is `'claude_code'` -- the Postgres enum, the column, this type). It used
 * to be `id: string`, spelled `'claude-code'` with a HYPHEN, which is the value `overview.ts` once
 * hardcoded; that property is gone, and the trap it left behind is worth remembering only because
 * an old row, an old log line or an old fixture can still carry the hyphenated form, and it is not
 * a member of this union.
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
 * packages/domain/src/provider/kind.ts, where the union is DECLARED (M56a R2), for why, and
 * apps/web/src/lib/providerLabel.ts, which re-exports that declaration under the same names, for
 * the client-safe mirror that exists because of it.
 */
export { PROVIDER_KINDS } from '@slave-of-ai/providers'
/** Re-exported for `capabilitiesOf`'s reason (M56a R10): `apps/web/src/server/settings.ts` names
 *  the adapter CLASS on each provider card, and the registry entry is where that name lives now
 *  instead of in a fourth hand-written array. A SERVER caller only -- this is a value from
 *  `@slave-of-ai/providers` and carries its `node:child_process` imports with it, exactly like
 *  `capabilitiesOf` above, which `settings.ts` already imports. */
export { PROVIDER_ADAPTERS } from '@slave-of-ai/providers'
export type { ProviderRegistration, ProviderWiring } from '@slave-of-ai/providers'
export * from './pause.js'
export * from './breaker.js'
export * from './broker.js'
export * from './stop.js'
export * from './emergency.js'
export * from './resume.js'
export * from './dependency.js'
export * from './goal.js'
export * from './feed.js'
export * from './workspace.js'
export * from './org.js'
export * from './catalog.js'
export * from './duplicates.js'
export * from './capability.js'
export * from './membership.js'
export * from './personSkills.js'
export * from './persons.js'
export * from './personPool.js'
export * from './credential.js'
export * from './triggers.js'
export * from './lifecycle.js'
export * from './runbook.js'
export * from './memory.js'
export * from './skills.js'
export * from './permission.js'
export * from './principal.js'
export * from './git-probe.js'
export * from './detect.js'
export * from './git.js'
export * from './collect.js'
export * from './integration.js'
export * from './evidence.js'
export * from './staffing.js'
export * from './unblock.js'
export * from './password.js'
export * from './users.js'
export * from './simulation.js'
export * from './messaging.js'
export * from './profile.js'
export * from './task.js'
export * from './supervisor.js'
export * from './supervisorWorld.js'
export * from './planningCount.js'
export * from './supervisorUploads.js'
export * from './supervisorChat.js'
export * from './supervisorChatTick.js'
export * from './spend.js'
export * from './stats.js'
export * from './intake.js'
export * from './intakeTick.js'
export * from './capabilityMapping.js'
export * from './capabilityMappingTick.js'
