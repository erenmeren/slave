'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { useEscapeStack } from './useModalDismiss'

/**
 * The two-click destructive action every M27 surface uses (spec §6). The caller composes
 * `confirmText` from server counts ("deletes Alex and 14 runs of history") -- this component
 * counts nothing. `onConfirm` resolves to a refusal string (shown in `${testId}-error`, the confirm
 * stays open) or `null` (done; the caller has refreshed or navigated).
 *
 * M44 R3 (erratum E12) widens it into the ONE two-step destructive control: it draws its trigger
 * and its confirm with `ui/Button`'s `danger` variant rather than a second button system, takes a
 * `title` so a disabled trigger can say why it is disabled, announces itself as an `alertdialog`
 * while it is asking, focuses the confirm on open and hands focus back to the trigger on Escape.
 */
export function DangerConfirm({
  label,
  testId,
  confirmText,
  disabled = false,
  title,
  onConfirm,
  className = '',
}: {
  readonly label: string
  readonly testId: string
  readonly confirmText: string
  readonly disabled?: boolean
  readonly title?: string
  readonly onConfirm: () => Promise<string | null>
  readonly className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const refocusTriggerRef = useRef(false)

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
  }, [open])

  // Through the SAME stack `useModalDismiss` uses, so a `DangerConfirm` inside a `Drawer` takes
  // one Escape for itself and leaves the drawer open (M44 R3 fix round 1). `enabled: !pending`:
  // mid-request the key is swallowed here rather than falling through to the drawer behind.
  useEscapeStack({
    open,
    enabled: !pending,
    onEscape: () => {
      // The idle trigger is UNMOUNTED while this is asking, so `triggerRef.current` is already
      // null here. The flag defers the intent to the effect below, which runs once the trigger has
      // remounted and re-attached its ref (the idiom `EmergencyStopButton` documented before M44
      // moved it here).
      refocusTriggerRef.current = true
      setOpen(false)
      setErrorText(null)
    },
  })

  useEffect(() => {
    if (open || !refocusTriggerRef.current) return
    refocusTriggerRef.current = false
    triggerRef.current?.focus()
  }, [open])

  const confirm = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const refusal = await onConfirm()
    setPending(false)
    if (refusal === null) setOpen(false)
    else setErrorText(refusal)
  }

  if (!open) {
    return (
      <Button
        ref={triggerRef}
        variant="danger"
        size="sm"
        data-testid={testId}
        disabled={disabled}
        {...(title === undefined ? {} : { title })}
        onClick={() => setOpen(true)}
        className={className}
      >
        {label}
      </Button>
    )
  }
  return (
    <span role="alertdialog" aria-label={`confirm ${label}`} className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>
      <Button ref={confirmRef} variant="danger" size="sm" data-testid={`${testId}-confirm`} disabled={pending} onClick={() => void confirm()}>
        {pending ? 'working…' : confirmText}
      </Button>
      <button type="button" data-testid={`${testId}-cancel`} disabled={pending} onClick={() => { setOpen(false); setErrorText(null) }} className="text-xs text-text-3">
        cancel
      </button>
      {errorText !== null && (
        <span role="alert" data-testid={`${testId}-error`} className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </span>
  )
}
