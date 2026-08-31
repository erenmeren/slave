import type React from 'react'

/**
 * The handoff's form language, written once (M16 spec §2). Appearance only: no state, no
 * fetch — behaviour stays with the callers, and every prop spread passes the caller's
 * testids, aria contracts, handlers and values through untouched. Radii live HERE and
 * nowhere else: 7px input/tile, 5px chip/button (README "Design Tokens").
 */
export function FieldLabel({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <span className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">{children}</span>
}

const INPUT_SHELL =
  'rounded-[7px] border border-line bg-bg-0 px-2.5 py-1.5 text-sm text-text-1 placeholder:text-text-3 focus:border-white/25 focus:outline-none'

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

export function GhostButton({ className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      className={`rounded-[5px] border border-line bg-transparent px-2.5 py-1 text-xs text-text-2 transition-colors hover:border-white/25 hover:text-text-0 disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ''}`.trim()}
    />
  )
}

export function PrimaryButton({
  tone = 'working',
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly tone?: 'working' | 'blocked' }): React.JSX.Element {
  const tones = {
    working: 'border-tone-working/40 bg-tone-working/15 text-tone-working',
    blocked: 'border-tone-blocked/40 bg-tone-blocked/15 text-tone-blocked',
  } as const
  return (
    <button
      type="button"
      {...rest}
      className={`rounded-[5px] border px-2.5 py-1 text-xs transition-[filter] hover:brightness-[1.35] disabled:opacity-50 disabled:cursor-not-allowed ${tones[tone]} ${className ?? ''}`.trim()}
    />
  )
}
