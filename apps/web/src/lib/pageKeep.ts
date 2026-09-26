/**
 * A tab's loaded list, held by the page ABOVE the tab so it outlives the tab unmounting (workforce
 * cards final review, finding 2): `WorkforceClient` renders one tab at a time, and a list re-seeded
 * from the server's load-time answer on every return would show rows its filter bar no longer
 * describes, and drop every card write and "Show more" page made before the switch. `query` is the
 * filters that list was read under, as URL params; `null` until the tab first mounts.
 */
export interface PageKeep<V> {
  current: { readonly view: V; readonly query: string } | null
}
