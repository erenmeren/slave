'use client'

import { useEffect, useRef, useState } from 'react'
import { postControl } from '../lib/postControl'

type Phase = 'idle' | 'confirm'

/**
 * The TopBar's workspace-wide emergency stop: idle red `STOP` button -> inline confirm (the
 * `NodeMenu` confirm idiom, no dialog dependency) -> POST `/api/w/:workspaceId/emergency-stop`.
 * Success does NOT flip anything locally — the workspace-wide snapshot refetch is what flips
 * `halted` (and therefore this button back to disabled, plus the `HaltBanner`) on every page.
 */
export function EmergencyStopButton({
  workspaceId,
  halted,
}: {
  readonly workspaceId: string
  readonly halted: boolean
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  // NodeMenu keeps its trigger mounted at all times, so its Escape handler can call
  // `triggerRef.current?.focus()` synchronously. Here the idle button unmounts entirely while
  // confirming (spec: "the button is replaced inline"), so `triggerRef.current` is already null
  // by the time Escape fires — this flag defers the same "focus the trigger" intent to the effect
  // below, once the idle button has remounted and re-attached the ref.
  const refocusTriggerRef = useRef(false)

  useEffect(() => {
    if (phase !== 'confirm') return
    confirmRef.current?.focus()

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      refocusTriggerRef.current = true
      setPhase('idle')
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [phase])

  useEffect(() => {
    if (phase !== 'idle' || !refocusTriggerRef.current) return
    refocusTriggerRef.current = false
    triggerRef.current?.focus()
  }, [phase])

  const confirm = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const result = await postControl(`/api/w/${workspaceId}/emergency-stop`)
    setPending(false)
    if (!result.ok) {
      setErrorText(result.error)
      return
    }
    setPhase('idle')
  }

  if (phase === 'confirm') {
    return (
      <span role="alertdialog" aria-label="confirm emergency stop" className="flex items-center gap-2">
        <button
          ref={confirmRef}
          type="button"
          data-testid="emergency-stop-confirm"
          disabled={pending}
          onClick={() => void confirm()}
          className="rounded border border-tone-blocked/40 bg-tone-blocked/10 px-2 py-1 text-xs text-tone-blocked disabled:opacity-60"
        >
          stop everything
        </button>
        <button
          type="button"
          data-testid="emergency-stop-cancel"
          onClick={() => setPhase('idle')}
          className="rounded border border-line px-2 py-1 text-xs text-text-2"
        >
          cancel
        </button>
        {errorText !== null && (
          <span role="alert" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </span>
    )
  }

  return (
    <button
      ref={triggerRef}
      type="button"
      data-testid="emergency-stop"
      disabled={halted}
      title={halted ? 'workspace is already halted' : undefined}
      onClick={() => setPhase('confirm')}
      className="rounded border border-tone-blocked/40 bg-tone-blocked/10 px-2 py-1 text-xs text-tone-blocked disabled:opacity-60"
    >
      STOP
    </button>
  )
}
