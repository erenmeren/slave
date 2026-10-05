'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

/**
 * A persona made by hand: a name, a role and one line on when to use it. It opens right after, so
 * its instructions and default skills can be written.
 */
export function NewPersonaDialog({ open, onOpenChange, onCreated }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onCreated: (templateId: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = name.trim() !== '' && role.trim() !== ''

  const close = (next: boolean): void => {
    if (!next) {
      setName('')
      setRole('')
      setDescription('')
      setError(null)
    }
    onOpenChange(next)
  }
  const create = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    const result = await api<{ id: string }>('/api/personas', { method: 'POST', body: { name, role, ...(description.trim() === '' ? {} : { description }) } })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success(`Created the persona ${name.trim()}`, { description: 'Write its instructions next.' })
    close(false)
    onCreated(result.data.id)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="new-persona-dialog">
        <DialogHeader>
          <DialogTitle>New persona</DialogTitle>
          <DialogDescription>A kind of specialist people are made from. You write its instructions and default skills after this.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="new-persona-name">Name</Label>
            <Input id="new-persona-name" data-testid="new-persona-name" autoComplete="off" placeholder="Payments Engineer" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-persona-role">Role</Label>
            <Input id="new-persona-role" data-testid="new-persona-role" autoComplete="off" placeholder="Backend engineer" value={role} onChange={(event) => setRole(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-persona-description">When to use them, in one line (optional)</Label>
            <Input id="new-persona-description" data-testid="new-persona-description" autoComplete="off" placeholder="Builds and audits payment flows." value={description} onChange={(event) => setDescription(event.target.value)} />
            <p className="text-xs text-muted-foreground">A lead reads this line to decide whom to call.</p>
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive" data-testid="new-persona-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || busy} data-testid="new-persona-submit">
              Create persona
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
