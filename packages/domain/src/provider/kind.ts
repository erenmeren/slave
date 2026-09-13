/**
 * Which runtime a run is on (M56a R2 -- MOVED here from `packages/providers/src/types.ts`, which
 * re-exports it).
 *
 * A plain string union, not a re-export of the Postgres enum (`packages/db`'s generated
 * `ProviderKind`): `packages/domain` depends on nothing but `zod`, and `packages/db`'s enum is held
 * to this list by `packages/db/test/integration/enum-parity.test.ts` rather than by a type.
 *
 * THE DOMAIN AND NOT THE PROVIDERS PACKAGE, because the dependency direction decides it. Five
 * packages independently needed to enumerate these two members and four of them could not reach
 * `@slave-of-ai/providers`: its barrel re-exports two adapters that import `node:child_process` at
 * module scope with no `sideEffects: false` escape hatch, so a VALUE import of anything from it --
 * even a two-string list -- would force a client bundle to evaluate Node-only code.
 * `apps/web/src/components/SlavePanel.tsx:5-12` already value-imports `PERMISSION_PROVIDERS` and
 * `TOOLS_BY_KIND` from THIS package in a client component, which is the proof that this home works
 * and that one does not.
 *
 * `apps/web/src/lib/providerLabel.ts:41-43` argued the opposite before this milestone -- "inventing
 * a second home for it in the domain would put the union in three places instead of two" -- and it
 * is answered rather than contradicted: the union was in TEN places, and this MOVES it rather than
 * copying it, which is the case that sentence never considered.
 */
export type ProviderKind = 'claude_code' | 'cursor'

/**
 * Every member of `ProviderKind`, as data. The canonical source for any caller that needs to
 * enumerate the kinds -- `packages/control/src/org.ts`'s `isProviderKind` is the reason this
 * exists. A hand-rolled list with no link back to the type is exactly the failure this guards
 * against: a third kind added to the union above without a matching entry here now fails the BUILD
 * (see `_ProviderKindsComplete` below) instead of leaving a validator silently two-wide. Mirrors
 * `capabilitiesOf`'s own `const unhandled: never` idiom -- one canonical table beats several that
 * agree today.
 */
export const PROVIDER_KINDS = ['claude_code', 'cursor'] as const satisfies readonly ProviderKind[]

// Compile-time completeness check: `satisfies` above proves every element of `PROVIDER_KINDS` is
// a `ProviderKind` (soundness); this proves the reverse -- every `ProviderKind` is IN
// `PROVIDER_KINDS` (completeness) -- so omitting a member is a build error, not a silent gap.
type _AssertNever<T extends never> = T
type _ProviderKindsComplete = _AssertNever<Exclude<ProviderKind, (typeof PROVIDER_KINDS)[number]>>

/**
 * The word a person reads for a runtime (M44 R4, final review item I3 -- MOVED here from
 * `apps/web/src/lib/providerLabel.ts`, which re-exports it under the same name).
 *
 * `claude_code` is a COLUMN VALUE. It was visible text on four surfaces -- the Overview slave
 * card's chip, the slave panel's chip, the Workforce table's provider cell and every provider
 * `<select>` -- which is exactly what R4 forbids, and `scripts/gate-m44-ux-foundation.mjs` derives
 * its blocklist from `PROVIDER_KINDS` so a fifth surface cannot reintroduce it.
 *
 * A PROJECTION, never a replacement (the rule `packages/domain/src/status/user.ts` states for
 * statuses): every call site keeps the raw kind beside the word, in `title` on a chip and in
 * `value` on an `<option>` -- the value a form posts and a column stores is untouched.
 *
 * `Record<ProviderKind, string>` is load-bearing: a third kind fails the build here rather than
 * rendering as a bare enum member. It is the FIFTH of the six sites §4's checklist keeps, and the
 * reason it is kept is that a product's word for a vendor is not derivable from the vendor's
 * binary name.
 */
export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  claude_code: 'Claude Code',
  cursor: 'Cursor',
}
