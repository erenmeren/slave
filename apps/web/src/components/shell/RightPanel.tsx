'use client'

import { useRightPanel } from './RightPanelProvider'

/**
 * The 372px slot (M57 R8).
 *
 * It owns the WIDTH, the surface and the 54px header bar; its content owns everything below. That
 * split is what lets `SlavePanel` and `TaskDetailPanel` move in here for the price of one className
 * each: they were `fixed inset-y-0 right-0 w-96` asides, and everything inside them was already a
 * vertical flex column that filled its parent.
 *
 * `children` is the DEFAULT content — the Supervisor, inside a project. Whatever the provider holds
 * replaces it while a task or a worker is selected, and comes back to it when that closes.
 */
export function RightPanel({
  title,
  children,
}: {
  readonly title: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  const { mode, content, close, collapse } = useRightPanel()
  const showing = mode ?? 'supervisor'
  return (
    <aside
      data-testid="right-panel"
      data-mode={showing}
      aria-label={showing === 'supervisor' ? 'Supervisor' : showing === 'task' ? 'Task detail' : 'Worker detail'}
      className="flex min-h-0 w-[372px] flex-none flex-col border-l border-line bg-panel"
    >
      {/* One header bar, at the header's own height, so the three columns line up across the top.
        * The panels that move in here bring their own title row BELOW this one -- theirs carries a
        * task id and a status pill, which this one cannot know about. */}
      <div className="flex h-[54px] flex-none items-center gap-2 border-b border-line px-[14px] pl-[16px]">
        <span className="flex-1 truncate text-[13.5px] font-semibold text-t1">{title}</span>
        {mode !== null && (
          <button
            type="button"
            data-testid="panel-close"
            aria-label="Close this panel"
            onClick={close}
            className="h-[30px] w-[30px] rounded-card border-0 bg-transparent text-[13px] text-t3 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            ✕
          </button>
        )}
        <button
          type="button"
          data-testid="panel-collapse"
          aria-label="Collapse the right panel"
          onClick={collapse}
          className="h-[30px] w-[30px] rounded-card border-0 bg-transparent text-[13px] text-t3 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          »
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{content ?? children}</div>
    </aside>
  )
}
