interface KeyLike { readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean }
/** ⌘ on macOS, Ctrl elsewhere; never Alt (Alt+letter types a glyph on macOS). */
export function isModKey(event: KeyLike): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey
}
export function matchesShortcut(event: KeyLike, spec: { readonly key: string; readonly shift?: boolean }): boolean {
  if (!isModKey(event)) return false
  if (event.key.toLowerCase() !== spec.key.toLowerCase()) return false
  return event.shiftKey === (spec.shift ?? false)
}
