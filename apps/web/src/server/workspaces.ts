import { prisma } from '@slave-of-ai/db/client'

/** Every workspace, name and id (M27 §3.3): hides an archived project by default, the same rule
 *  `listProjects`/`listWorkspaceNames` follow. */
export async function listWorkspaces(
  options?: { readonly includeArchived?: boolean },
): Promise<readonly { id: string; name: string }[]> {
  return prisma.workspace.findMany({
    where: options?.includeArchived === true ? {} : { archivedAt: null },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
}
