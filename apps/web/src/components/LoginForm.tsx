'use client'

import { useState } from 'react'
import { sendControl } from '../lib/postControl'
import { PrimaryButton, TextField } from './ui/FormControls'

/** Two fields, one button, the M16 kit (M23 spec §7 F5). Submits through `sendControl` like every
 *  other mutation in this app; on success the browser navigates to `next` (already run through
 *  `safeNext` by the page). A refusal lands in the error band, never blank (M14 rule). The
 *  `autoComplete` pair is what lets a password manager recognise this as a login and offer the
 *  saved account. */
export function LoginForm({ next }: { readonly next: string }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const failure = await sendControl('/api/auth/login', { method: 'POST', body: { username, password } })
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
        label="username"
        inputProps={
          {
            type: 'text',
            name: 'username',
            autoComplete: 'username',
            autoFocus: true,
            value: username,
            onChange: (event) => setUsername(event.target.value),
            'data-testid': 'login-username',
          } as React.InputHTMLAttributes<HTMLInputElement>
        }
      />
      <TextField
        label="password"
        inputProps={
          {
            type: 'password',
            name: 'password',
            autoComplete: 'current-password',
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
      <PrimaryButton type="submit" data-testid="login-submit" disabled={busy || username.length === 0 || password.length === 0}>
        sign in
      </PrimaryButton>
    </form>
  )
}
