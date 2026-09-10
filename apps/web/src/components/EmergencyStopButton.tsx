'use client'

import { postControl } from '../lib/postControl'
import { DangerConfirm } from './ui/DangerConfirm'

/**
 * The project header's workspace-wide emergency stop: red `STOP` -> inline confirm -> POST
 * `/api/w/:workspaceId/emergency-stop`. Success does NOT flip anything locally — the
 * workspace-wide snapshot refetch is what flips `halted` (and therefore this button back to
 * disabled, plus the `HaltBanner`) on every page.
 *
 * M44 R3: the two-step confirm, the deferred trigger-refocus on Escape and the `alertdialog`
 * announcement all moved into `ui/DangerConfirm` — this file DOCUMENTED that idiom before the
 * shared component existed, and every destructive control in the app now asks twice the same way.
 * `confirmName` keeps the announcement this control has always made: the visible label is a shout
 * (`STOP`), and "confirm emergency stop" is the sentence to read out.
 */
export function EmergencyStopButton({
  workspaceId,
  halted,
}: {
  readonly workspaceId: string
  readonly halted: boolean
}): React.JSX.Element {
  return (
    <DangerConfirm
      label="STOP"
      testId="emergency-stop"
      confirmText="stop everything"
      confirmName="confirm emergency stop"
      disabled={halted}
      {...(halted ? { title: 'workspace is already halted' } : {})}
      onConfirm={async () => {
        const result = await postControl(`/api/w/${workspaceId}/emergency-stop`)
        return result.ok ? null : result.error
      }}
    />
  )
}
