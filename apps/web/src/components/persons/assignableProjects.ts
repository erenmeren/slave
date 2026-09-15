/** A project the person panel can assign a slave onto, with the departments that live on it. */
export interface AssignableProject {
  readonly workspaceId: string
  readonly projectName: string
  readonly teams: readonly { readonly teamId: string; readonly name: string }[]
}

/**
 * Group department rows by project. Lives in a server-safe module so the Overview page (a server
 * component) can build the same list the person panel's assign form uses, without importing a
 * `'use client'` file.
 */
export function assignableProjectsOf(
  teams: readonly { readonly teamId: string; readonly name: string; readonly workspaceId: string; readonly projectName: string }[],
): readonly AssignableProject[] {
  const byWorkspace = new Map<string, { workspaceId: string; projectName: string; teams: { teamId: string; name: string }[] }>()
  for (const team of teams) {
    const existing = byWorkspace.get(team.workspaceId)
    if (existing === undefined) {
      byWorkspace.set(team.workspaceId, {
        workspaceId: team.workspaceId,
        projectName: team.projectName,
        teams: [{ teamId: team.teamId, name: team.name }],
      })
    } else {
      existing.teams.push({ teamId: team.teamId, name: team.name })
    }
  }
  return [...byWorkspace.values()]
}
