'use client'

import { useEffect, useState } from 'react'
import { PrimaryButton } from './FormControls'

/**
 * The two-click destructive action every M27 surface uses (spec §6). The caller composes
 * `confirmText` from server counts ("deletes Alex and 14 runs of history") -- this component
 * counts nothing. `onConfirm` resolves to a refusal string (shown in `${testId}-error`, the confirm
 * stays open) or `null` (done; the caller has refreshed or navigated).
 */
export function DangerConfirm({
  label,
  testId,
  confirmText,
  disabled = false,
  onConfirm,
  className = '',
}: {
  readonly label: string
  readonly testId: string
  readonly confirmText: string
  readonly disabled?: boolean
  readonly onConfirm: () => Promise<string | null>
  readonly className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) {
        setOpen(false)
        setErrorText(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, pending])

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
      <PrimaryButton tone="blocked" data-testid={testId} disabled={disabled} onClick={() => setOpen(true)} className={className}>
        {label}
      </PrimaryButton>
    )
  }
  return (
    <span className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>
      <PrimaryButton tone="blocked" data-testid={`${testId}-confirm`} disabled={pending} onClick={() => void confirm()}>
        {pending ? 'working…' : confirmText}
      </PrimaryButton>
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
