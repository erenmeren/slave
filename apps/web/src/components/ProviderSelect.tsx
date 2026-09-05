'use client'

import type { ProviderKind } from '@slave-of-ai/control'

/**
 * Every `ProviderKind`, as `<option>` values -- guarded the same way
 * `packages/providers/src/types.ts`'s canonical `PROVIDER_KINDS` is (`satisfies` + the
 * `Exclude<..., never>` completeness check): a third `ProviderKind` added to that union without a
 * matching entry here now fails the BUILD, not just this file's compile, so both copies go stale
 * together or not at all.
 *
 * This is a SEPARATE list from that canonical one, not an import of it (M12 Task 13 fix round 1,
 * Important finding 1's remedy weighed against the client/server boundary the same review praised
 * elsewhere): `@slave-of-ai/providers`'s package entry (`index.ts`) re-exports `claude/adapter.ts`
 * and `cursor/adapter.ts`, both of which import `node:child_process` at module scope with no
 * `sideEffects: false` escape hatch, so a VALUE import of anything from that barrel -- even this
 * two-string list -- would force a client bundle to evaluate (and likely fail on) Node-only code.
 * `@slave-of-ai/control`'s barrel re-exports the same list for exactly this reason: safe for a
 * SERVER caller, not for this file. Two independently compiler-guarded lists is the deliberate
 * trade against that risk, not an oversight.
 */
const PROVIDER_KINDS = ['claude_code', 'cursor'] as const satisfies readonly ProviderKind[]
type _AssertNever<T extends never> = T
type _ProviderKindsComplete = _AssertNever<Exclude<ProviderKind, (typeof PROVIDER_KINDS)[number]>>

/**
 * The shared `(provider, model)` pair's provider half (M12 Task 13 fix round 1, Important finding
 * 2): `ModelOverrideEditor`, `TemplateCatalog`'s creation form and `CompanyManager`'s add-member
 * form each rendered their own ~16-line `<select>` block, differing only in `aria-label`,
 * `data-testid` and a Tailwind width -- this collapses that to one edit point. Every prop the
 * three call sites varied is explicit here rather than defaulted, so the brief's own
 * `aria-label="provider"` requirement (`ModelOverrideEditor`) and the other two sites' distinct
 * labels/test-ids are the CALLER's choice, not baked in.
 */
export function ProviderSelect({
  ariaLabel,
  testId,
  value,
  onChange,
  disabled,
  placeholder,
  className,
}: {
  readonly ariaLabel: string
  readonly testId: string
  readonly value: ProviderKind | ''
  readonly onChange: (value: ProviderKind | '') => void
  readonly disabled: boolean
  readonly placeholder: string
  readonly className: string
}): React.JSX.Element {
  return (
    <select
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value as ProviderKind | '')}
      disabled={disabled}
      className={className}
    >
      <option value="">{placeholder}</option>
      {PROVIDER_KINDS.map((kind) => (
        <option key={kind} value={kind}>
          {kind}
        </option>
      ))}
    </select>
  )
}
