'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ThemeSwitch } from '@/components/app/ThemeSwitch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

/** One runtime as the Settings screen shows it: found on this machine or not, and its version. */
export interface RuntimeCard {
  readonly kind: string
  readonly label: string
  readonly found: boolean
  readonly version: string | null
}

/**
 * Lead UX design section 6.6: how is this installation set up? Runtimes found on this machine,
 * where new repositories go (changeable), appearance, and -- with accounts on -- who is signed in.
 * In development only, Reset demo data.
 */
export function SettingsView({
  runtimes,
  reposRoot,
  posture,
  username,
  showReseed,
}: {
  readonly runtimes: readonly RuntimeCard[]
  readonly reposRoot: { readonly stored: string | null; readonly resolved: string }
  readonly posture: string
  readonly username: string | null
  readonly showReseed: boolean
}): React.JSX.Element {
  const router = useRouter()
  const [root, setRoot] = useState(reposRoot.stored ?? '')
  const [busy, setBusy] = useState(false)

  const saveRoot = async (value: string | null): Promise<void> => {
    setBusy(true)
    const result = await api('/api/installation', { method: 'POST', body: { reposRoot: value } })
    setBusy(false)
    if (result.ok) toast.success('Saved')
    else toast.error(result.error)
    router.refresh()
  }

  const reseed = async (): Promise<void> => {
    setBusy(true)
    const result = await api('/api/dev/reseed', { method: 'POST' })
    setBusy(false)
    if (result.ok) toast.success('Demo data reset')
    else toast.error(result.error)
    router.refresh()
  }

  const signOut = async (): Promise<void> => {
    await api('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <div className="mx-auto flex w-full max-w-[800px] flex-col gap-6 px-4 py-8 md:px-8" data-testid="settings">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card data-testid="settings-runtimes">
        <CardHeader>
          <CardTitle className="text-base">Runtimes</CardTitle>
          <CardDescription>The AI coding tools Slave can run on this machine. A lead runs on Claude Code.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            {runtimes.map((runtime) => (
              <li key={runtime.kind} className="flex items-center justify-between gap-3 py-2 text-sm" data-testid="runtime" data-found={runtime.found}>
                <span className="font-medium">{runtime.label}</span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {runtime.version !== null && <span className="font-mono text-xs">{runtime.version}</span>}
                  <Badge variant="outline" className={runtime.found ? 'border-transparent bg-success-muted text-success-foreground' : ''}>
                    {runtime.found ? 'Found' : 'Not found'}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card data-testid="settings-repos">
        <CardHeader>
          <CardTitle className="text-base">Where new repositories go</CardTitle>
          <CardDescription>
            When a new project needs a new repository, it is made in <span className="font-mono text-foreground">{reposRoot.resolved}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor="repos-root">Folder (an absolute path; empty for the default)</Label>
          <div className="flex gap-2">
            <Input id="repos-root" className="font-mono" value={root} onChange={(event) => setRoot(event.target.value)} placeholder={reposRoot.resolved} data-testid="repos-root" />
            <Button variant="outline" disabled={busy} onClick={() => void saveRoot(root.trim() === '' ? null : root.trim())} data-testid="repos-root-save">
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Appearance</CardTitle>
        </CardHeader>
        <CardContent>
          <ThemeSwitch />
        </CardContent>
      </Card>

      <Card data-testid="settings-account">
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
          <CardDescription>{posture}</CardDescription>
        </CardHeader>
        {username !== null && (
          <CardContent>
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          </CardContent>
        )}
      </Card>

      {showReseed && (
        <Card className="border-destructive/40" data-testid="settings-reseed">
          <CardHeader>
            <CardTitle className="text-base">Reset demo data</CardTitle>
            <CardDescription>Development only: replaces everything in this database with the demo projects.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" disabled={busy} onClick={() => void reseed()}>
              Reset demo data
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
