'use client'

import { useEffect } from 'react'
import { ProjectsPanel } from '../ProjectsPanel'

/**
 * "New project" (M24 §5.2): today's attach-a-repo form in a right-hand drawer. A `role="dialog"`
 * panel over a scrim rather than `<dialog>`, matching `AssignCompanyDialog`'s idiom; Escape and the
 * scrim close it. M26 replaces the body with the intake chat — the trigger, the `?new=1` opener
 * and this frame are the seam it lands in.
 */
export function NewProjectDrawer({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button type="button" aria-label="close" data-testid="new-project-scrim" onClick={onClose} className="flex-1 bg-black/50" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="New project"
        data-testid="new-project-drawer"
        className="flex w-[520px] max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New project</h2>
          <button type="button" data-testid="new-project-close" onClick={onClose} className="text-text-3 hover:text-text-1">
            ✕
          </button>
        </div>
        <p className="text-xs text-text-3">attach a local git repository as a project — its verify commands decide when a task is done</p>
        <ProjectsPanel />
      </aside>
    </div>
  )
}
