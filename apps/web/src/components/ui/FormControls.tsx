import type React from 'react'
import { Button } from './Button'
import { SECTION_LABEL_CLASS } from './SectionLabel'

/**
 * The handoff's form language, written once (M16 spec §2). Appearance only: no state, no
 * fetch — behaviour stays with the callers, and every prop spread passes the caller's
 * testids, aria contracts, handlers and values through untouched. The FIELD radius lives here
 * (`rounded-tile`, the 7px input/tile token); the 5px chip/button radius now lives in `ui/Button`,
 * which the two button aliases at the bottom of this file delegate to (M44 R3/E14).
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

/**
 * M44 R3: the second button system is gone. These two are ALIASES of `ui/Button` at `size="sm"`,
 * which is that component's name for the exact geometry these carried (`px-2.5 py-1`, radius 5) --
 * so the thirty-five call sites did not move when the two systems became one. They stay exported
 * so this milestone is not also a thirty-five-file rename; Task 4 migrates the call sites and
 * these go with the last of them.
 */
export function GhostButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <Button variant="ghost" size="sm" {...props} />
}

export function PrimaryButton({
  tone = 'working',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly tone?: 'working' | 'blocked' }): React.JSX.Element {
  return <Button variant={tone === 'blocked' ? 'danger' : 'primary'} size="sm" {...rest} />
}
