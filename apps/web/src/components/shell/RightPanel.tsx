'use client'

import { useRightPanel } from './RightPanelProvider'

/**
 * The 340px slot (M57 R8, narrowed from 372px by M61 R4 to fit the new 1024px floor).
 *
 * It owns the WIDTH, the surface and the 48px header bar (the app header's own height, R6 -- the
 * two bars start at the same y and a 6px difference between them is a visible step); its content owns everything below. That
 * split is what lets `SlavePanel` and `TaskDetailPanel` move in here for the price of one className
 * each: they were `fixed inset-y-0 right-0 w-96` asides, and everything inside them was already a
 * vertical flex column that filled its parent.
 *
 * `children` is the DEFAULT content — the Supervisor, inside a project. Whatever the provider holds
 * replaces it while a task or a worker is selected, and comes back to it when that closes.
 */
export function RightPanel({
  children,
}: {
  /** Unused: the visible title and the landmark name are both DERIVED from `mode` below, never
   *  passed in -- a caller-supplied string could drift from the mode it is drawn beside. Kept
   *  optional so an existing call site may still pass one without a type error. */
  readonly title?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  const { mode, content, close, collapse } = useRightPanel()
  const showing = mode ?? 'supervisor'
  // One label, three uses: the visible header text, the Supervisor mode's own landmark name, and
  // (by NOT being applied) the reason task/slave mode has none of its own -- see the aside below.
  const label = showing === 'supervisor' ? 'Supervisor' : showing === 'task' ? 'Task detail' : 'Slave detail'
  return (
    <aside
      data-testid="right-panel"
      data-mode={showing}
      // Supervisor mode is the only content this slot draws itself, so it is the only mode where
      // THIS element is the landmark. In task/slave mode the content mounted below already renders
      // its own labelled `<aside>` (`TaskDetailPanel`/`SlavePanel`, which also render standalone on
      // routes with no slot) -- carrying an `aria-label` here too would put two `complementary`
      // landmarks named "Task detail" (or "Slave detail") on the page for the one panel a person
      // sees. `role="presentation"` strips this element from the landmark tree entirely, leaving
      // the inner one as the sole named `complementary` region.
      aria-label={showing === 'supervisor' ? label : undefined}
      role={showing === 'supervisor' ? undefined : 'presentation'}
      className="glass flex min-h-0 w-[340px] flex-none flex-col border-l border-edge"
    >
      {/* One header bar, at the header's own height, so the three columns line up across the top.
        * The panels that move in here bring their own title row BELOW this one -- theirs carries a
        * task id and a status pill, which this one cannot know about. */}
      <div className="flex h-[48px] flex-none items-center gap-2 border-b border-line px-[14px] pl-[16px]">
        <span className="flex-1 truncate text-[13.5px] font-semibold text-t1">{label}</span>
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
