import type React from 'react'
import { SECTION_LABEL_CLASS } from './SectionLabel'

/**
 * The handoff's form language, written once (M16 spec §2). Appearance only: no state, no
 * fetch — behaviour stays with the callers, and every prop spread passes the caller's
 * testids, aria contracts, handlers and values through untouched. The FIELD radius lives here
 * (`rounded-tile`, the 7px input/tile token); the 5px chip/button radius lives in `ui/Button`.
 *
 * There is no button here any more. `GhostButton`/`PrimaryButton` were this file's own second
 * button system; M44 R3 folded them into `ui/Button` as `size="sm"` aliases and Task 4 migrated
 * the last of their thirty-odd call sites, so they are gone -- a `<GhostButton>` anywhere is a
 * BUILD error now rather than a second way to draw the same control.
 */
export function FieldLabel({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <span className={SECTION_LABEL_CLASS}>{children}</span>
}

// Exported so a shell the kit cannot own directly (a shared component wrapped at its call
// site, e.g. ProviderSelect in RuntimePanel.tsx) can still use the exact same radius/border/text
// shell rather than hand-copying this string.
export const INPUT_SHELL =
  'rounded-tile border border-line bg-bg-0 px-2.5 py-1.5 text-sm text-text-1 placeholder:text-text-3 focus:border-white/25 focus:outline-none'

export function TextField({
  label,
  inputProps,
}: {
  readonly label?: string
  readonly inputProps: React.InputHTMLAttributes<HTMLInputElement>
}): React.JSX.Element {
  const input = <input {...inputProps} className={`${INPUT_SHELL} ${inputProps.className ?? ''}`.trim()} />
  if (label === undefined) return input
  return (
    <label className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      {input}
    </label>
  )
}

export function SelectField({
  label,
  selectProps,
  children,
}: {
  readonly label?: string
  readonly selectProps: React.SelectHTMLAttributes<HTMLSelectElement>
  readonly children: React.ReactNode
}): React.JSX.Element {
  const select = (
    <select {...selectProps} className={`${INPUT_SHELL} ${selectProps.className ?? ''}`.trim()}>
      {children}
    </select>
  )
  if (label === undefined) return select
  return (
    <label className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      {select}
    </label>
  )
}
