'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendControl } from '../lib/postControl'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { SECTION_LABEL_CLASS } from './ui/SectionLabel'

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
 *
 * M44 R3: the keyboard and the focus belong to `ui/Dialog` now -- Escape (ordered against every
 * other open layer), the scrim, the Tab trap, focus into the first control on open and focus back
 * to whatever opened it on close. This file had hand-rolled the first, the last and a
 * `triggerRef` prop for a `Button` that could not take a ref; `Button` forwards one now, and the
 * primitive reads the opener off `document.activeElement`, so the prop is gone.
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
    const error = await sendControl(`/api/w/${workspaceId}/company`, { method: 'POST', body: { companyId: selectedId } })
    if (error === null) {
      router.refresh()
      onClose()
    } else {
      setErrorText(error)
    }
    setPending(false)
  }

  return (
    // Rendered only while it is open (`ProjectsClient` mounts it conditionally), so `open` is a
    // constant here; the primitive still owns everything that follows from it.
    <Dialog open onClose={onClose} label="assign company" testId="assign-company-dialog" dismissible={!pending}>
      <h3 className={SECTION_LABEL_CLASS}>Assign a company</h3>
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
        <p role="alert" data-testid="assign-error" className="text-xs text-tone-blocked">
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
    </Dialog>
  )
}
