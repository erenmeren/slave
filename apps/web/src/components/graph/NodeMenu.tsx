'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'

/** The two node kinds that carry a menu -- `'task'` also covers the org-mode active-task
 *  satellite (Task 7 brief: "same target surface" as a deps-mode task node), so callers pass
 *  `'task'` for both rather than this module knowing about a third kind. Workspace/team nodes
 *  have no menu at all (M5's "controls live in the panel" decision, plus neither has a detail
 *  surface to deep-link to) -- see `OrgNodes.tsx`'s `WorkspaceNode`/`TeamNode`, which render no
 *  `NodeMenu`. */
export type NodeMenuKind = 'agent' | 'task'

interface MenuLink {
  readonly label: string
  readonly href: string
}

/** The four navigation targets from the Task 7 brief, two per kind -- pure so the href shape is
 *  directly testable without mounting anything. `id` is the bare domain id (already stripped of
 *  the node-id prefix, e.g. `agent:`/`task:`/`activeTask:` -- see each node renderer's own
 *  stripping in `OrgNodes.tsx`/`TaskNodes.tsx`), never the React Flow node id. */
function menuLinks(kind: NodeMenuKind, workspaceId: string, id: string): readonly MenuLink[] {
  if (kind === 'agent') {
    return [
      { label: 'Open panel', href: `/w/${workspaceId}?agent=${id}` },
      { label: 'Show in Activity', href: `/w/${workspaceId}/activity?agents=${id}` },
    ]
  }
  return [
    { label: 'Open in board', href: `/w/${workspaceId}/tasks?task=${id}` },
    { label: 'Show in Activity', href: `/w/${workspaceId}/activity?tasks=${id}` },
  ]
}

export interface NodeMenuProps {
  readonly kind: NodeMenuKind
  readonly workspaceId: string
  /** Bare domain id -- already stripped of the node-id prefix by the caller. */
  readonly id: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

/**
 * Navigation-only context menu (Task 7 -- no interventions here, that's the panel's job per M5).
 * A controlled component: the node renderer that embeds this owns the open/closed boolean (it
 * also needs it to wire the node's own right-click, which this component doesn't see directly --
 * see `OrgNodes.tsx`/`TaskNodes.tsx`), this owns only the trigger button, the popover's contents,
 * and closing itself on Escape / an outside click.
 *
 * The trigger is a real `<button>` at all times (not conditionally rendered), so it stays
 * tab-reachable regardless of hover state -- callers make it *visually* hover/focus-revealed with
 * their own `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100` classes on the
 * node's wrapper (`opacity` alone never removes an element from the tab order, unlike `hidden`).
 */
export function NodeMenu({ kind, workspaceId, id, open, onOpenChange }: NodeMenuProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onOpenChange(false)
    }
    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) onOpenChange(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open, onOpenChange])

  const links = menuLinks(kind, workspaceId, id)

  return (
    <div ref={rootRef} data-testid="node-menu-root" className="absolute right-1 top-1">
      <button
        type="button"
        data-testid="node-menu-trigger"
        aria-label="Node actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          // Nodes are draggable in React Flow -- stop the click reaching its own mousedown/drag
          // handling so a trigger click never also starts (or ends) a drag.
          event.stopPropagation()
          onOpenChange(!open)
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className="rounded px-1 text-xs leading-none text-text-3 opacity-0 outline-none transition-opacity hover:bg-bg-2 hover:text-text-1 focus:opacity-100 focus-visible:ring-1 focus-visible:ring-text-2 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          data-testid="node-menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-40 rounded border border-line bg-bg-1 py-1 shadow-lg"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              role="menuitem"
              data-testid="node-menu-item"
              onClick={() => onOpenChange(false)}
              className="block px-3 py-1.5 text-xs text-text-2 hover:bg-bg-2 hover:text-text-1"
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
