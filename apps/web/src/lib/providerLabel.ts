import { PROVIDER_KINDS, PROVIDER_LABEL, type ProviderKind } from '@slave-of-ai/domain'

/**
 * Every `ProviderKind`, and the word a person reads for each -- both RE-EXPORTED from
 * `@slave-of-ai/domain` (M56a R2), which is where they are declared.
 *
 * This file used to carry a second, independently-guarded copy of the list and the only copy of the
 * table, and its own docstring argued for both: "the provider vocabulary belongs to
 * `@slave-of-ai/providers`, whose value exports a client bundle cannot reach, and inventing a second
 * home for it in the domain would put the union in three places instead of two". The first half is
 * still true and is exactly why the union did not move THERE; the second half was answered by
 * counting -- the union was in ten places, and M56a MOVED it rather than copying it.
 *
 * A VALUE import of `@slave-of-ai/domain` is safe in a client component and a value import of
 * `@slave-of-ai/providers` is not: the providers barrel re-exports two adapters that import
 * `node:child_process` at module scope with no `sideEffects: false` escape hatch, while the domain
 * depends on nothing but `zod`. `apps/web/src/components/SlavePanel.tsx:5-12` already value-imports
 * `PERMISSION_PROVIDERS` and `TOOLS_BY_KIND` from the domain in a client component, and has since
 * M52.
 *
 * Re-exported rather than replaced because four client components and
 * `apps/web/test/provider-select.test.tsx` import these two names FROM THIS PATH, and
 * `docs/ia.md` rule 2 is that nothing is removed, only moved.
 */
export { PROVIDER_KINDS, PROVIDER_LABEL }
export type { ProviderKind }

/** The em dash every one of these surfaces already showed for "no run has resolved a provider"
 *  (M12 Task 9, ruling R10), so the null case is spelled once rather than at four call sites. */
export function providerLabel(kind: ProviderKind | null): string {
  return kind === null ? '—' : PROVIDER_LABEL[kind]
}
