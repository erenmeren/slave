'use client'

import { useState } from 'react'
import { Button } from '../ui/Button'

/**
 * Delete, with the count (M58 R13).
 *
 * The confirmation states how many OTHER projects go, because that is the fact a person clicking
 * Delete on one project's panel cannot see: "this slave works on 2 other projects; all of it goes".
 * Two clicks, never one -- the same arming shape the header's Stop button uses.
 */
export function DeletePersonButton({
  personId,
  name,
  projects,
  onDeleted,
}: {
  readonly personId: string
  readonly name: string
  /** Every project the person holds an OPEN seat on. The count in the sentence is this list's
   *  length minus the one the panel was opened from, when there is one -- the caller passes the
   *  OTHERS, so this component never has to know where it is being rendered. */
  readonly projects: readonly string[]
  readonly onDeleted: () => void
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const remove = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch(`/api/persons/${personId}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null)
        setErrorText(
          payload !== null && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : 'that could not be done',
        )
        return
      }
      onDeleted()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button variant="ghost" size="sm" data-testid="person-delete" disabled={pending} onClick={() => setArmed(true)}>
        Delete {name}
      </Button>
      {armed && (
        <div className="flex flex-col gap-1.5 rounded border border-tone-blocked/40 bg-tone-blocked/10 px-2 py-1.5">
          <p data-testid="person-delete-count" className="text-xs text-tone-blocked">
            {projects.length === 0
              ? `${name} is on no project. Every run, message and thing they learnt goes with them, and it cannot be undone.`
              : `${name} works on ${projects.length === 1 ? '1 other project' : `${String(projects.length)} other projects`} ` +
                `(${projects.join(', ')}); all of it goes — every seat, every run, every message and everything they ` +
                'learnt. It cannot be undone.'}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" data-testid="person-delete-confirm" disabled={pending} onClick={() => void remove()}>
              Yes, delete
            </Button>
            <Button variant="ghost" size="sm" data-testid="person-delete-cancel" disabled={pending} onClick={() => setArmed(false)}>
              Cancel
            </Button>
          </div>
          {errorText !== null && (
            <span role="alert" data-testid="person-delete-error" className="text-xs text-tone-blocked">{errorText}</span>
          )}
        </div>
      )}
    </div>
  )
}
