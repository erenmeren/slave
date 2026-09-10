'use client'

import type { ProviderKind } from '@slave-of-ai/control'
import { PROVIDER_KINDS, PROVIDER_LABEL } from '../lib/providerLabel'

/**
 * The shared `(provider, model)` pair's provider half (M12 Task 13 fix round 1, Important finding
 * 2): `ModelOverrideEditor`, `TemplateForm`'s creation form and `CompanyManager`'s add-member
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
      {/* The WORD is `PROVIDER_LABEL`'s (M44 R4, final review item I3); the raw kind stays the
        * option's `value` -- what this form posts and what the column stores -- and is repeated
        * in `title` so an operator can still read the exact enum member off the control. */}
      {PROVIDER_KINDS.map((kind) => (
        <option key={kind} value={kind} title={kind}>
          {PROVIDER_LABEL[kind]}
        </option>
      ))}
    </select>
  )
}
