'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'

/**
 * Lead UX design section 6.3, "Delete…": what goes, what stays, and the project's name typed to
 * confirm -- a delete cannot be undone, so the button stays off until the name matches. The
 * refusal (something still runs) is shown in the dialog in the control layer's own words.
 */
export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
  onDeleted,
}: {
  readonly project: { readonly id: string; readonly name: string; readonly repoPath: string }
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onDeleted: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await api(`/api/w/${project.id}`, { method: 'DELETE' })
    setBusy(false)
    if (!result.ok) {
      setError(result.status === 409 ? `Stop the project and wait for its work to end first. (${result.error})` : result.error)
      return
    }
    toast.success(`Deleted ${project.name}`, { description: `The code in ${project.repoPath} was not touched.` })
    onOpenChange(false)
    onDeleted()
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTyped('')
          setError(null)
        }
        onOpenChange(next)
      }}
    >
      <AlertDialogContent data-testid="delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the project, every build, check, note and cost record of it from Slave. The code in{' '}
            <span className="font-mono text-foreground">{project.repoPath}</span> is not touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="delete-confirm">Type the project&apos;s name to confirm</Label>
          <Input id="delete-confirm" data-testid="delete-confirm" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={project.name} />
          {error !== null && (
            <p role="alert" data-testid="delete-error" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" data-testid="delete-submit" disabled={busy || typed !== project.name} onClick={() => void remove()}>
            {busy ? 'Deleting…' : 'Delete project'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
