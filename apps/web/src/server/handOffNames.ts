import { prisma } from '@slave-of-ai/db/client'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '@slave-of-ai/db'
import { handOffViews } from '@slave-of-ai/control'
import { handOffFromName } from '@slave-of-ai/domain'

/**
 * Pre-flight F65 (human cards plan A carry, plan B Task 8): who each package-less hand-off on a
 * page came from, by its id -- named the way the goal report and the workers' prompts name it
 * (`handOffViews` + `handOffFromName`): a person's request or late answer as the operator's, a
 * worker's late answer by its seat, the Supervisor's as the conductor's. A hand-off from a package
 * is named by its package off the event alone, so only the package-less ones are read: one query
 * for their rows, and `handOffViews`' own reads only when one is a late answer. None when the page
 * holds no such event.
 */
export async function packageLessHandOffNames(
  workspaceId: string,
  rows: readonly { readonly type: string; readonly payload: unknown }[],
): Promise<ReadonlyMap<string, string>> {
  const ids = rows.flatMap((row) => {
    if (row.type !== EVENT_TYPE_BY_DOMAIN_TYPE['workspace.package_handed_off']) return []
    const payload = (row.payload ?? {}) as Record<string, unknown>
    const id = payload['handOffId']
    return payload['fromPackage'] == null && typeof id === 'string' ? [id] : []
  })
  if (ids.length === 0) return new Map()
  const handOffs = await prisma.packageHandOff.findMany({
    where: { workspaceId, id: { in: [...new Set(ids)] } },
    select: { id: true, workspaceId: true, source: true, sourceKey: true, fromPackageKey: true, path: true, packageKey: true, change: true },
  })
  const views = await handOffViews(handOffs)
  return new Map(views.map((view) => [view.id, handOffFromName(view)] as const))
}
