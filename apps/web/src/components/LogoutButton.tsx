'use client'

import { useState } from 'react'
import { sendControl } from '../lib/postControl'
import { GhostButton } from './ui/FormControls'

/** Settings' Logout (M20 spec §3.4): clears the cookie through the logout route, then lands on
 *  /login. A refusal (a cross-site call, a dead server) shows beside the button, never blank. */
export function LogoutButton(): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function logout(): Promise<void> {
    setBusy(true)
    setError(null)
    const failure = await sendControl('/api/auth/logout', { method: 'POST' })
    if (failure === null) {
      window.location.assign('/login')
      return
    }
    setBusy(false)
    setError(failure)
  }

  return (
    <div className="flex items-center gap-2">
      <GhostButton data-testid="logout" disabled={busy} onClick={() => void logout()}>
        log out
      </GhostButton>
      {error !== null && (
        <span role="alert" className="text-xs text-tone-blocked">
          {error}
        </span>
      )}
    </div>
  )
}
