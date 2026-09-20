/**
 * Where you are, said once (M57 R6, carried into M61 R8/R18).
 *
 * `ProjectTabs.tsx` used to hold this — a `TABS` array, an `ADVANCED` array and an `isLive`
 * predicate, all inside a client component — and `Sidebar.tsx` held a second, different answer to
 * the same question in its own `isCurrent`. This module is the one answer: the sidebar tree, the
 * header's breadcrumb and `gate:m57-ui-redesign` all read it, and nothing else in the tree may
 * derive a section from a pathname.
 *
 * No React import, deliberately: it is a pure table plus string functions, so it is unit tested
 * with no DOM and the gate can recompute the same table it renders.
 *
 * M61 folded the old six `SECTIONS` and three `VIEWS` into six `TABS` -- Graph and Office moved
 * from the `Advanced ▾`/chip row onto the tab strip itself, Overview became Team (the project's own
 * page), and Tasks became Work. `TABS` is now MODE-AWARE: `tabsFor('simple')` answers the first
 * four, `tabsFor('developer')` all six (spec R8). `RAIL` is new: the left rail's five destinations,
 * three of them (Home, People, Settings) for everybody and two (Simulations, Analytics) for
 * developers only (spec R18). THE ROUTES DO NOT CHANGE (`docs/ia.md` rule 2) -- every destination
 * still lives at the same URL; only labels and grouping moved.
 */

import type { Mode } from './modeStorage'

export type TabId = 'team' | 'tasks' | 'office' | 'activity' | 'graph' | 'knowledge'

export type Section = TabId | 'settings'

export interface TabSpec {
  readonly id: TabId
  readonly label: string
  readonly href: (workspaceId: string, mode: Mode) => string
  readonly modes: readonly Mode[]
}

const BOTH: readonly Mode[] = ['simple', 'developer']
const DEV: readonly Mode[] = ['developer']

/** The six tabs on a project's own strip, team first (README order). `id` is the ROUTE SEGMENT,
 *  not the label -- the same discipline `SECTIONS` kept, and what lets `sectionOf` stay a lookup.
 *  Activity alone reads `mode`: simple mode opens it on the digest view, developer mode on the raw
 *  river (spec R10). */
export const TABS: readonly TabSpec[] = [
  { id: 'team', label: 'Team', href: (id) => `/w/${id}`, modes: BOTH },
  { id: 'tasks', label: 'Work', href: (id) => `/w/${id}/tasks`, modes: BOTH },
  { id: 'office', label: 'Office', href: (id) => `/w/${id}/office`, modes: BOTH },
  {
    id: 'activity',
    label: 'Activity',
    href: (id, mode) => (mode === 'simple' ? `/w/${id}/activity?view=digest` : `/w/${id}/activity`),
    modes: BOTH,
  },
  { id: 'graph', label: 'Graph', href: (id) => `/w/${id}/graph`, modes: DEV },
  { id: 'knowledge', label: 'Knowledge', href: (id) => `/w/${id}/knowledge`, modes: DEV },
]

/** The subset of `TABS` a mode shows -- four for simple, all six for developer (spec R8). */
export function tabsFor(mode: Mode): readonly TabSpec[] {
  return TABS.filter((tab) => tab.modes.includes(mode))
}

export type RailId = 'home' | 'people' | 'settings' | 'simulations' | 'analytics'

export interface RailSpec {
  readonly id: RailId
  readonly label: string
  readonly href: string
  readonly modes: readonly Mode[]
}

/** The left rail's global destinations. Home, People and Settings for everybody; Simulations and
 *  Analytics only in developer mode (spec R18) -- a person in simple mode has no comparison runs
 *  and no cross-project chart to reach. */
export const RAIL: readonly RailSpec[] = [
  { id: 'home', label: 'Home', href: '/', modes: BOTH },
  { id: 'people', label: 'People', href: '/workforce', modes: BOTH },
  { id: 'settings', label: 'Settings', href: '/settings', modes: BOTH },
  { id: 'simulations', label: 'Simulations', href: '/sim', modes: DEV },
  { id: 'analytics', label: 'Analytics', href: '/analytics', modes: DEV },
]

/** The subset of `RAIL` a mode shows. */
export function railFor(mode: Mode): readonly RailSpec[] {
  return RAIL.filter((item) => item.modes.includes(mode))
}

/** Which rail item a GLOBAL pathname lights, or null inside a project -- the rail answers for the
 *  routes outside `/w/:id`, the tab strip for the ones inside it. */
export function railIdOf(pathname: string): RailId | null {
  if (workspaceIdOf(pathname) !== null) return null
  const path = pathname.split('?')[0] ?? pathname
  if (path === '/') return 'home'
  const hit = RAIL.find((item) => item.href !== '/' && (path === item.href || path.startsWith(`${item.href}/`)))
  return hit?.id ?? null
}

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

const TAB_IDS: ReadonlySet<string> = new Set(TABS.map((tab) => tab.id))

/** The segment after `/w/<id>`, or null. Shared by `sectionOf` and `viewOf` so the two can never
 *  disagree about what a path's third part is. */
function segmentOf(pathname: string): string | null {
  const parts = pathname.split('/').filter((part) => part.length > 0)
  if (parts[0] !== 'w' || parts[1] === undefined) return null
  return parts[2] ?? null
}

/**
 * Which section a pathname is on, or null.
 *
 * A bare `/w/<id>` AND `/w/<id>/organization` (the old Team route, still the redirect target --
 * R7) both answer `team`: Team is the project's own page, the same way Overview was. `settings` is
 * a section too, even though it is no longer one of the six `TABS` -- it still has its own route
 * and its own crumb, just not a place on the tab strip. Every other deeper path answers by its
 * FIRST segment, so `/w/<id>/tasks?filter=x` and any future `/w/<id>/tasks/<sub>` both light the
 * Work tab.
 */
export function sectionOf(pathname: string): Section | null {
  if (workspaceIdOf(pathname) === null) return null
  const segment = segmentOf(pathname)
  if (segment === null || segment === 'organization') return 'team'
  if (segment === 'settings') return 'settings'
  return TAB_IDS.has(segment) ? (segment as TabId) : null
}

export type ViewId = 'analytics'

export interface ViewSpec {
  readonly id: ViewId
  readonly label: string
  readonly href: (workspaceId: string) => string
}

/** What is left of the old `VIEWS` chip group now that Graph and Office are tabs: Analytics alone,
 *  still a project-scoped chip because its route carries no `/w/:id` prefix of its own. */
export const VIEWS: readonly ViewSpec[] = [
  { id: 'analytics', label: 'Analytics', href: (id) => `/analytics?workspace=${id}` },
]

/** Always null now: Graph and Office answer through `sectionOf` instead. Kept so a caller written
 *  against the old three-view contract still compiles and still gets a true answer (there is no
 *  view left that a path alone can name -- Analytics needs the search string). */
export function viewOf(_pathname: string): ViewId | null {
  return null
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
 * `Projects / <project> / <tab>` (README "Shell" → Header).
 *
 * The project's Team tab ends at the project: Team IS the project's page (the same rule Overview
 * had), and a third crumb reading "Team" would be saying the same thing twice -- true of both
 * `/w/<id>` and its `/organization` redirect target. `projectName` is null until the layout's read
 * lands, and the id stands in — never an empty crumb, which would render as a stray separator.
 */
export function breadcrumbOf(pathname: string, projectName: string | null): readonly Crumb[] {
  const workspaceId = workspaceIdOf(pathname)
  if (workspaceId === null) {
    const hit = GLOBAL_CRUMB.find(
      (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
    )
    return [{ text: hit?.text ?? 'Projects', last: true }]
  }
  const section = sectionOf(pathname)
  const leaf =
    TABS.find((tab) => tab.id === section && tab.id !== 'team')?.label ??
    (section === 'settings' ? 'Settings' : null)
  const project: Crumb = { text: projectName ?? workspaceId, last: leaf === null }
  const crumbs: Crumb[] = [{ text: 'Projects', last: false }, project]
  if (leaf !== null) crumbs.push({ text: leaf, last: true })
  return crumbs
}
