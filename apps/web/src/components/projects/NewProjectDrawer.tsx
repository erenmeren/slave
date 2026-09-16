'use client'

import { Drawer } from '../ui/Drawer'
import { IntakeConversation } from './IntakeConversation'

/**
 * "New project" (M24 §5.2), and since M59 R16 the body is the seam M24 reserved: a conversation,
 * not a form. The trigger, the `?new=1` opener and this frame are unchanged, and so are Escape,
 * the scrim, the Tab trap and focus restore (M44 R3's `ui/Drawer`).
 *
 * The form is not gone: `IntakeConversation`'s fill in by hand link swaps this body for
 * `ProjectsPanel`, pre-filled with whatever the conversation reached.
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
      <p className="text-xs text-text-3">tell it what you want to build — it will read the repository and suggest the rest</p>
      <IntakeConversation onClose={onClose} />
    </Drawer>
  )
}
