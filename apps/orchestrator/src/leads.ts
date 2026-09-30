import { prisma } from '@slave-of-ai/db/client'
import { leadFromReport, type WorkerLead } from '@slave-of-ai/domain'

/**
 * Skeleton spec S8: every package's latest report, read as leads (plan A D11), in key order -- the
 * newest `RunReport` per package, the one `loadGoalReport` shows.
 *
 * Its own module because two readers share it: the verifier (every package) and a package's
 * contract (spec C2 "dependency leads", only `keys`), and `verification.ts` imports `runContext.ts`,
 * so the contract builder cannot import it from there.
 */
export async function workerLeads(workspaceId: string, goalVersion: number, keys?: readonly string[]): Promise<readonly WorkerLead[]> {
  if (keys !== undefined && keys.length === 0) return []
  const packages = await prisma.workPackage.findMany({
    where: { workspaceId, goalVersion, ...(keys === undefined ? {} : { key: { in: [...keys] } }) },
    orderBy: { key: 'asc' },
    select: { key: true, reports: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { report: true } } },
  })
  return packages.flatMap((pkg) => {
    const stored = pkg.reports[0]
    const lead = stored === undefined ? null : leadFromReport(pkg.key, stored.report)
    return lead === null ? [] : [lead]
  })
}
