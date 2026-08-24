'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from './ui/Button'

/** Pulls a 409 refusal's `{ error }` text, falling back to something nameable for any other
 *  non-2xx or malformed body -- the `errorMessage` idiom `GoalCard.tsx`/`EmergencyStopButton.tsx`
 *  already use, copied rather than imported (a small local copy is the house pattern here, not a
 *  shared control-plane module). */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

export interface AssignCompanyDialogProps {
  readonly workspaceId: string
  readonly companies: readonly { readonly id: string; readonly name: string }[]
  readonly onClose: () => void
}

/**
 * The Projects card's "assign company" affordance: pick a company, confirm, POST the assign
 * route. Truth from snapshot -- a 200 triggers `router.refresh()` and closes (the refreshed
 * Projects page is what actually shows the new company badge, not anything set locally here); a
 * 409 renders its refusal text inline and leaves the dialog open so the caller can try again.
 */
export function AssignCompanyDialog({ workspaceId, companies, onClose }: AssignCompanyDialogProps): React.JSX.Element {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    if (selectedId === null) return
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch(`/api/w/${workspaceId}/company`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedId }),
      })
      if (response.ok) {
        router.refresh()
        onClose()
        return
      }
      const data: unknown = await response.json().catch(() => null)
      setErrorText(errorMessage(data, response.status))
    } catch (cause) {
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="assign company"
        data-testid="assign-company-dialog"
        className="flex w-72 flex-col gap-3 rounded-panel border border-line bg-bg-1 p-4 shadow-resting"
      >
        <h3 className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">Assign a company</h3>
        {companies.length === 0 ? (
          <p className="text-xs text-text-3">no companies yet -- create one in Settings.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {companies.map((company) => (
              <li key={company.id}>
                <button
                  type="button"
                  data-testid="company-option"
                  aria-pressed={selectedId === company.id}
                  onClick={() => setSelectedId(company.id)}
                  className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                    selectedId === company.id ? 'bg-bg-2 text-text-1' : 'text-text-2 hover:text-text-1'
                  }`}
                >
                  {company.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {errorText !== null && (
          <p role="alert" data-testid="assign-error" className="text-xs text-status-danger">
            {errorText}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" data-testid="assign-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="assign-confirm"
            disabled={selectedId === null || pending}
            onClick={() => void confirm()}
          >
            Assign
          </Button>
        </div>
      </div>
    </div>
  )
}
