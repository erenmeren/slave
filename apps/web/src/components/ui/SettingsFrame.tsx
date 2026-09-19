import { ScrollArea } from './ScrollArea'

/**
 * The two-column Settings frame (M61 R12/R13, Task 9): a 180px nav of section buttons beside a
 * `760px` scrollable content column -- the README's own `180px minmax(0,760px)` split, the same
 * shape `ProjectSettingsClient`'s sticky in-page nav used before this task, now driven by
 * `?section=` instead of an anchor scroll.
 *
 * Presentational and controlled, like `ui/Segmented`: the caller owns `current` and `onSelect`
 * (and therefore the URL that survives a reload), and `children` is whatever section the caller
 * chose to mount -- `SettingsFrame` renders no section content of its own, and nothing here reads
 * `?section=` directly. Both callers (`SettingsClient`, `ProjectSettingsClient`) keep every one of
 * their `data-testid="settings-<id>"` sections mounted-on-demand rather than all at once, which is
 * what `?section=` bookmarking and a reload both need to agree on.
 */
export function SettingsFrame({
  sections,
  current,
  onSelect,
  children,
}: {
  readonly sections: readonly { readonly id: string; readonly label: string }[]
  readonly current: string
  readonly onSelect: (id: string) => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[180px_minmax(0,760px)] gap-[var(--gap-3)] p-[var(--gap-3)]">
      <nav data-testid="settings-nav" className="flex flex-col gap-1 text-[13px]">
        {sections.map((section) => {
          const chosen = section.id === current
          return (
            <button
              key={section.id}
              type="button"
              data-testid="settings-nav-item"
              data-section={section.id}
              aria-current={chosen ? 'page' : undefined}
              onClick={() => onSelect(section.id)}
              className={`rounded-control px-2.5 py-1.5 text-left transition-colors ${
                chosen ? 'bg-sel font-medium text-t1' : 'text-t2 hover:bg-hover hover:text-t1'
              }`}
            >
              {section.label}
            </button>
          )
        })}
      </nav>
      <ScrollArea>{children}</ScrollArea>
    </div>
  )
}
