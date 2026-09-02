'use client'

import { useState } from 'react'
import { sendControl } from '../lib/postControl'
import { PrimaryButton, TextField } from './ui/FormControls'

/** One field, one button, the M16 kit (M20 spec §3.3). Submits through `sendControl` like every
 *  other mutation in this app; on success the browser navigates to `next` (already run through
 *  `safeNext` by the page). A refusal lands in the error band, never blank (M14 rule). */
export function LoginForm({ next }: { readonly next: string }): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const failure = await sendControl('/api/auth/login', { method: 'POST', body: { password } })
    if (failure === null) {
      window.location.assign(next)
      return
    }
    setBusy(false)
    setError(failure)
  }

  return (
    <form data-testid="login-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <TextField
        label="password"
        inputProps={
          {
            type: 'password',
            name: 'password',
            autoComplete: 'current-password',
            autoFocus: true,
            value: password,
            onChange: (event) => setPassword(event.target.value),
            'data-testid': 'login-password',
          } as React.InputHTMLAttributes<HTMLInputElement>
        }
      />
      {error !== null && (
        <p role="alert" data-testid="login-error" className="text-xs text-tone-blocked">
          {error}
        </p>
      )}
      <PrimaryButton type="submit" data-testid="login-submit" disabled={busy || password.length === 0}>
        sign in
      </PrimaryButton>
    </form>
  )
}
