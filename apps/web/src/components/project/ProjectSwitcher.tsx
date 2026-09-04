'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

/** The project header's name button and its dropdown (M24 §2.2): every workspace by name, the
 *  current one marked, and a last row that opens the Projects page's New project drawer. A plain
 *  popover (no `<dialog>`): it is a navigation menu, not a modal, and Escape/outside-click close it. */
export function ProjectSwitcher({
  current,
  workspaces,
}: {
  readonly current: { readonly id: string; readonly name: string }
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onClick = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="project-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-[6px] rounded-nav px-[6px] py-[3px] text-[14.5px] font-semibold tracking-[-.2px] text-text-1 hover:bg-white/[0.045]"
      >
        <span className="truncate">{current.name}</span>
        <span aria-hidden className="text-[10px] text-text-3">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          data-testid="project-switcher-menu"
          className="absolute left-0 top-full z-20 mt-1 flex min-w-[220px] flex-col gap-px rounded-panel border border-line bg-bg-1 p-1 shadow-[0_6px_22px_rgba(0,0,0,.45)]"
        >
          {workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              role="menuitem"
              data-testid="project-switcher-row"
              href={`/w/${workspace.id}`}
              aria-current={workspace.id === current.id ? 'true' : undefined}
              onClick={() => setOpen(false)}
              className={`truncate rounded-nav px-[9px] py-[6px] text-[12.5px] ${
                workspace.id === current.id ? 'bg-[#151a21] text-text-1' : 'text-text-2 hover:bg-white/[0.045] hover:text-text-1'
              }`}
            >
              {workspace.name}
            </Link>
          ))}
          <Link
            role="menuitem"
            data-testid="project-switcher-new"
            href="/?new=1"
            onClick={() => setOpen(false)}
            className="mt-1 border-t border-line px-[9px] pt-[7px] pb-[4px] font-mono text-[10.5px] text-tone-working hover:text-text-1"
          >
            + New project
          </Link>
        </div>
      )}
    </div>
  )
}
