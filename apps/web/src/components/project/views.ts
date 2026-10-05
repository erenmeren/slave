/** The Project screen's views: what it always showed, the team as a diagram, the build in time. */
export const PROJECT_VIEWS = ['overview', 'diagram', 'timeline'] as const
export type ProjectViewName = (typeof PROJECT_VIEWS)[number]

/** The view a URL names (`?view=diagram`); anything else is Overview. */
export function viewOf(raw: string | readonly string[] | null | undefined): ProjectViewName {
  const value = typeof raw === 'string' ? raw : null
  return (PROJECT_VIEWS as readonly string[]).includes(value ?? '') ? (value as ProjectViewName) : 'overview'
}

/** Where a view lives: the project's own address, with `?view=` for all but Overview. */
export function viewHref(pathname: string, view: ProjectViewName): string {
  return view === 'overview' ? pathname : `${pathname}?view=${view}`
}
