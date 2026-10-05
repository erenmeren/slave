'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

/**
 * Lead UX design section 6.7: name, password, Sign in; the refusal in words under it. On success
 * the browser goes to `next`, which the page already made safe (`safeNext`). The `autoComplete`
 * pair lets a password manager recognise the form.
 */
export function LoginForm({ next }: { readonly next: string }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await api('/api/auth/login', { method: 'POST', body: { username, password } })
    if (result.ok) {
      window.location.assign(next)
      return
    }
    setBusy(false)
    setError(result.error)
  }

  return (
    <form data-testid="login-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="login-username">Name</Label>
        <Input id="login-username" name="username" autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} data-testid="login-username" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="login-password">Password</Label>
        <Input id="login-password" type="password" name="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} data-testid="login-password" />
      </div>
      {error !== null && (
        <p role="alert" data-testid="login-error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" data-testid="login-submit" disabled={busy || username.length === 0 || password.length === 0}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
