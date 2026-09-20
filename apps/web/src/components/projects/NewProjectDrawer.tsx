'use client'

import { Sheet } from '../ui/Sheet'
import { IntakeConversation } from './IntakeConversation'

/**
 * "New project" (M24 §5.2), and since M59 R16 the body is the seam M24 reserved: a conversation,
 * not a form. M61 Task 8 moves the frame from `ui/Drawer` to `ui/Sheet` (R15/R16) -- the header's
 * title and close button are `Sheet`'s own now (it draws both), so the hand-rolled `<h2>`/
 * `new-project-close` button this file used to carry are gone; Escape, the scrim, the Tab trap and
 * focus restore are still there, just `Sheet`'s version of them (draggable-to-dismiss, on the
 * glass surface, from the right).
 *
 * The form is not gone: `IntakeConversation`'s fill in by hand link swaps this body for
 * `ProjectsPanel`, pre-filled with whatever the conversation reached.
 */
export function NewProjectDrawer({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): React.JSX.Element {
  return (
    <Sheet open={open} onClose={onClose} title="New project" testId="new-project-sheet">
      <p className="type-meta mb-3 text-t3">
        tell it what you want to build — it will read the repository and suggest the rest
      </p>
      <IntakeConversation onClose={onClose} />
    </Sheet>
  )
}
