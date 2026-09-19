/** A single keyboard shortcut key (M61 R16), e.g. `<Kbd>⌘K</Kbd>` beside a search field or a
 *  command hint. A real `<kbd>` element -- assistive tech and browser find-in-page both already
 *  know what to do with one. */
export function Kbd({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <kbd className="rounded-[4px] border border-line2 bg-panel px-1.5 font-mono text-[10.5px] text-t2">{children}</kbd>
}
