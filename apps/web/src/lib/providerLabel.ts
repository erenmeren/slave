import type { ProviderKind } from '@slave-of-ai/control'

/**
 * Every `ProviderKind`, guarded the same way `packages/providers/src/types.ts`'s canonical
 * `PROVIDER_KINDS` is (`satisfies` + the `Exclude<..., never>` completeness check): a third
 * `ProviderKind` added to that union without a matching entry here fails the BUILD, not just this
 * file's compile, so both copies go stale together or not at all.
 *
 * This is a SEPARATE list from that canonical one, not an import of it (M12 Task 13 fix round 1,
 * Important finding 1's remedy weighed against the client/server boundary the same review praised
 * elsewhere; MOVED here verbatim from `ProviderSelect.tsx` in the M44 fix wave, because the label
 * table below has four call sites and only one of them is that component):
 * `@slave-of-ai/providers`'s package entry (`index.ts`) re-exports `claude/adapter.ts` and
 * `cursor/adapter.ts`, both of which import `node:child_process` at module scope with no
 * `sideEffects: false` escape hatch, so a VALUE import of anything from that barrel -- even this
 * two-string list -- would force a client bundle to evaluate (and likely fail on) Node-only code.
 * `@slave-of-ai/control`'s barrel re-exports the same list for exactly this reason: safe for a
 * SERVER caller, not for a file four client components import. The TYPE import above is erased at
 * compile time and reaches no runtime module. Two independently compiler-guarded lists is the
 * deliberate trade against that risk, not an oversight.
 */
export const PROVIDER_KINDS = ['claude_code', 'cursor'] as const satisfies readonly ProviderKind[]
type _AssertNever<T extends never> = T
type _ProviderKindsComplete = _AssertNever<Exclude<ProviderKind, (typeof PROVIDER_KINDS)[number]>>

/**
 * The word a person reads for a runtime (M44 R4, final review item I3).
 *
 * `claude_code` is a COLUMN VALUE. It was visible text on four surfaces -- the Overview slave
 * card's chip, the slave panel's chip, the Workforce table's provider cell and every provider
 * `<select>` -- which is exactly what R4 forbids, and `scripts/gate-m44-ux-foundation.mjs` now
 * derives its blocklist from `PROVIDER_KINDS` so a fifth surface cannot reintroduce it.
 *
 * A PROJECTION, never a replacement (the rule `packages/domain/src/status/user.ts` states for
 * statuses): every call site keeps the raw kind beside the word, in `title` on a chip and in
 * `value` on an `<option>` -- the value a form posts and a column stores is untouched.
 *
 * `Record<ProviderKind, string>` is load-bearing: a third kind fails the build here rather than
 * rendering as a bare enum member.
 *
 * NOT in `packages/domain`: the provider vocabulary belongs to `@slave-of-ai/providers`, whose
 * value exports a client bundle cannot reach (see above), and inventing a second home for it in
 * the domain would put the union in three places instead of two.
 */
export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  claude_code: 'Claude Code',
  cursor: 'Cursor',
}

/** The em dash every one of these surfaces already showed for "no run has resolved a provider"
 *  (M12 Task 9, ruling R10), so the null case is spelled once rather than at four call sites. */
export function providerLabel(kind: ProviderKind | null): string {
  return kind === null ? '—' : PROVIDER_LABEL[kind]
}
