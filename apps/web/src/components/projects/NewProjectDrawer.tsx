'use client'

import { Drawer } from '../ui/Drawer'
import { ProjectsPanel } from '../ProjectsPanel'

/**
 * "New project" (M24 §5.2): today's attach-a-repo form in a right-hand drawer. M26 replaces the
 * body with the intake chat — the trigger, the `?new=1` opener and this frame are the seam it
 * lands in.
 *
 * M44 R3: the frame is `ui/Drawer` now, so Escape, the scrim, the Tab trap and focus restore are
 * the ONE implementation every modal in this app shares rather than this file's own `useEffect`.
 * The scrim's testid moved with it (`new-project-drawer-scrim`, the primitive's `${testId}-scrim`).
 */
export function NewProjectDrawer({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): React.JSX.Element | null {
  return (
    <Drawer open={open} onClose={onClose} label="New project" testId="new-project-drawer">
      <div className="flex items-center justify-between">
        <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New project</h2>
        <button type="button" data-testid="new-project-close" onClick={onClose} className="text-text-3 hover:text-text-1">
          ✕
        </button>
      </div>
      <p className="text-xs text-text-3">attach a local git repository as a project — its verify commands decide when a task is done</p>
      <ProjectsPanel />
    </Drawer>
  )
}
