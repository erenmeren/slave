export * from './paths.js'
export * from './kill.js'
export * from './refusal.js'
export * from './budget.js'
export * from './runtime.js'

/**
 * Re-exported so `apps/web` can NAME the runtime it renders (M12 Task 9, ruling R10). The web app
 * depends on `@ai-team-os/control` but not on `@ai-team-os/providers`, and `AgentRun.provider` now
 * reaches the Overview as real data rather than a hardcoded string -- so the surface needs the
 * type. Re-exporting here is a strictly smaller change than adding a dependency edge from the web
 * app to the providers package, which it otherwise has no business importing from: it must never
 * construct an adapter.
 *
 * Note the spelling, which is a real trap on this seam: `'claude_code'` is the `ProviderKind`
 * (the Postgres enum, the column, this type); `'claude-code'` is the ADAPTER ID
 * (`ClaudeCodeAdapter.id`), which is what `overview.ts` used to hardcode.
 */
export type { ProviderKind } from '@ai-team-os/providers'
/**
 * Re-exported alongside `ProviderKind` for the same reason (M12 Task 13): the roster's data
 * loader (`apps/web/src/server/org.ts`) needs the shell-only gate mark for a worker's resolved
 * provider, and `capabilitiesOf` -- the one capability table (see this function's own docstring
 * in `@ai-team-os/providers`) -- is a pure lookup on a `ProviderKind` alone, not an adapter
 * construction. Re-exporting it here keeps the web app off the providers package the same way the
 * type re-export above does, rather than growing a second table of the same facts in `apps/web`.
 */
export { capabilitiesOf } from '@ai-team-os/providers'
export type { ProviderCapabilities } from '@ai-team-os/providers'
export * from './pause.js'
export * from './stop.js'
export * from './emergency.js'
export * from './resume.js'
export * from './dependency.js'
export * from './goal.js'
export * from './org.js'
