/**
 * Where you are, said once (M57 R6).
 *
 * `ProjectTabs.tsx` used to hold this — a `TABS` array, an `ADVANCED` array and an `isLive`
 * predicate, all inside a client component — and `Sidebar.tsx` held a second, different answer to
 * the same question in its own `isCurrent`. This module is the one answer: the sidebar tree, the
 * header's breadcrumb and `gate:m57-ui-redesign` all read it, and nothing else in the tree may
 * derive a section from a pathname.
 *
 * No React import, deliberately: it is a pure table plus five string functions, so it is unit
 * tested with no DOM and the gate can recompute the same table it renders.
 *
 * THE ROUTES DO NOT CHANGE. `docs/ia.md` rule 2 is about destinations, and every destination the
 * old tab strip and its `Advanced ▾` menu pointed at is here, at the same URL. Only two LABELS
 * move: `/w/:id/organization` is called `Team` (what the page is about is the people on it, and
 * "Organization" was the graph mode's word) and the three `Advanced` items are called `VIEWS`.
 */

export type Section = 'overview' | 'tasks' | 'organization' | 'knowledge' | 'activity' | 'settings'

export type ViewId = 'graph' | 'office' | 'analytics'

export interface SectionSpec {
  readonly id: Section
  readonly label: string
  readonly href: (workspaceId: string) => string
}

/** The six rows nested under the current project in the sidebar tree, in the README's order.
 *  `id` is the ROUTE SEGMENT, not the label — that is what makes `sectionOf` a lookup and what
 *  lets `gate-m49-memory.mjs`'s set assertion carry over unchanged (plan erratum E7). */
export const SECTIONS: readonly SectionSpec[] = [
  { id: 'overview', label: 'Overview', href: (id) => `/w/${id}` },
  { id: 'tasks', label: 'Tasks', href: (id) => `/w/${id}/tasks` },
  { id: 'organization', label: 'Team', href: (id) => `/w/${id}/organization` },
  { id: 'knowledge', label: 'Knowledge', href: (id) => `/w/${id}/knowledge` },
  { id: 'activity', label: 'Activity', href: (id) => `/w/${id}/activity` },
  { id: 'settings', label: 'Settings', href: (id) => `/w/${id}/settings` },
]

export interface ViewSpec {
  readonly id: ViewId
  readonly label: string
  readonly href: (workspaceId: string) => string
}

/** The `VIEWS` chip group — exactly what `Advanced ▾` held (M44 R2, `docs/ia.md`), visible now
 *  instead of behind a menu. Analytics keeps the global route and this project's `?workspace=`
 *  scope, unchanged and bookmarkable. */
export const VIEWS: readonly ViewSpec[] = [
  { id: 'graph', label: 'Graph', href: (id) => `/w/${id}/graph` },
  { id: 'office', label: 'Office', href: (id) => `/w/${id}/office` },
  { id: 'analytics', label: 'Analytics', href: (id) => `/analytics?workspace=${id}` },
]

/** `/w/<id>` and `/w/<id>/<rest>` → `<id>`; anything else → null. A bare `/w` and a bare `/w/`
 *  are not project routes and must not answer an empty string. */
export function workspaceIdOf(pathname: string): string | null {
  const parts = pathname.split('/').filter((part) => part.length > 0)
  if (parts[0] !== 'w') return null
  const id = parts[1]
  return id === undefined || id.length === 0 ? null : id
}

/** True for every route outside a project — the ones with no right panel and no dock (R8). */
export function isGlobalRoute(pathname: string): boolean {
  return workspaceIdOf(pathname) === null
}

const SECTION_IDS: ReadonlySet<string> = new Set(SECTIONS.map((section) => section.id))
const VIEW_IDS: ReadonlySet<string> = new Set(['graph', 'office'])

/** The segment after `/w/<id>`, or null. Shared by `sectionOf` and `viewOf` so the two can never
 *  disagree about what a path's third part is. */
function segmentOf(pathname: string): string | null {
  const parts = pathname.split('/').filter((part) => part.length > 0)
  if (parts[0] !== 'w' || parts[1] === undefined) return null
  return parts[2] ?? null
}

/**
 * Which of the six sections a pathname is on, or null.
 *
 * A bare `/w/<id>` is `overview` (it is the project's own page), a deeper path answers by its
 * FIRST segment (so `/w/<id>/tasks?filter=x` and any future `/w/<id>/tasks/<sub>` both light the
 * Tasks row), and a VIEW answers null — a view is beside the sections, not one of them.
 */
export function sectionOf(pathname: string): Section | null {
  if (workspaceIdOf(pathname) === null) return null
  const segment = segmentOf(pathname)
  if (segment === null) return 'overview'
  return SECTION_IDS.has(segment) ? (segment as Section) : null
}

/** Which VIEW a project pathname is on. Analytics can never answer here: its route has no `/w/:id`
 *  prefix at all, so the chip's own current-ness is decided from the search string by its caller. */
export function viewOf(pathname: string): ViewId | null {
  if (workspaceIdOf(pathname) === null) return null
  const segment = segmentOf(pathname)
  return segment !== null && VIEW_IDS.has(segment) ? (segment as ViewId) : null
}

export interface Crumb {
  readonly text: string
  /** The last crumb is the one the header paints in `--t1` at weight 600; the rest are `--t3`. */
  readonly last: boolean
}

/** What each global route calls itself in the breadcrumb. One entry per top-level destination;
 *  a path that matches none of them falls back to `Projects`, which is where the tree's root is. */
const GLOBAL_CRUMB: readonly { readonly prefix: string; readonly text: string }[] = [
  { prefix: '/workforce', text: 'Workforce' },
  { prefix: '/sim', text: 'Simulations' },
  { prefix: '/settings', text: 'Settings' },
  { prefix: '/analytics', text: 'Analytics' },
  { prefix: '/login', text: 'Sign in' },
]

/**
 * `Projects / <project> / <section>` (README "Shell" → Header).
 *
 * The project's Overview ends at the project: Overview IS the project's page, and a third crumb
 * reading "Overview" would be saying the same thing twice. `projectName` is null until the layout's
 * read lands, and the id stands in — never an empty crumb, which would render as a stray separator.
 */
export function breadcrumbOf(pathname: string, projectName: string | null): readonly Crumb[] {
  const workspaceId = workspaceIdOf(pathname)
  if (workspaceId === null) {
    const hit = GLOBAL_CRUMB.find(
      (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
    )
    return [{ text: hit?.text ?? 'Projects', last: true }]
  }
  const leaf =
    SECTIONS.find((section) => section.id === sectionOf(pathname) && section.id !== 'overview')?.label ??
    VIEWS.find((view) => view.id === viewOf(pathname))?.label ??
    null
  const project: Crumb = { text: projectName ?? workspaceId, last: leaf === null }
  const crumbs: Crumb[] = [{ text: 'Projects', last: false }, project]
  if (leaf !== null) crumbs.push({ text: leaf, last: true })
  return crumbs
}
