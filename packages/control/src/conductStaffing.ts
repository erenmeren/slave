import { prisma } from '@slave-of-ai/db/client'
import { PACKAGE_WORKER_ROLE, err, ok, type PackageSpec, type Result } from '@slave-of-ai/domain'
import { hireFromTemplate, mergeRuntimeRoles } from './capability.js'
import { refusalText } from './refusal.js'

/**
 * One seat per package (spec R5, plan decision D2). For each package in order: an open, unreleased
 * seat of the package's persona in this workspace that no other package of this allocation took
 * and that holds no LIVE package task; else a new seat from the persona's managed pool. Every seat
 * returned holds PACKAGE_WORKER_ROLE. Not one transaction -- `hireFromTemplate` runs its own -- so
 * a failure part-way leaves idle seats the next attempt reuses, never a duplicate.
 *
 * A package task is live until it has failed, been cancelled, or is done AND integrated: a `done`
 * task whose branch is still waiting to be merged by hand is still that seat's work, and a second
 * package on the seat would be written on top of it.
 */
export async function staffPackages(
  workspaceId: string,
  goalVersion: number,
  packages: readonly Pick<PackageSpec, 'key' | 'templateId'>[],
): Promise<Result<ReadonlyMap<string, string>, string>> {
  const open = await prisma.slave.findMany({
    where: { team: { workspaceId }, closedAt: null, person: { releasedAt: null } },
    select: { id: true, runtimeRoles: true, person: { select: { templateId: true } } },
    orderBy: { id: 'asc' },
  })
  const live = await prisma.task.findMany({
    where: {
      workspaceId,
      workPackageId: { not: null },
      assigneeId: { not: null },
      NOT: [{ status: { in: ['failed', 'cancelled'] } }, { status: 'done', integratedAt: { not: null } }],
    },
    select: { assigneeId: true },
  })
  const holding = new Set(live.map((task) => task.assigneeId))

  const taken = new Set<string>()
  const seats = new Map<string, string>()
  for (const pkg of packages) {
    const reuse = open.find((s) => s.person.templateId === pkg.templateId && !taken.has(s.id) && !holding.has(s.id))
    let seat: string
    let roles: readonly string[]
    if (reuse !== undefined) {
      seat = reuse.id
      roles = reuse.runtimeRoles
    } else {
      const hired = await hireFromTemplate(workspaceId, pkg.templateId, {
        rationale: `Conductor: package "${pkg.key}" of goal v${String(goalVersion)}`,
        requirePool: true,
        newSeat: true,
      })
      if (!hired.ok) return err(noSeat(pkg, refusalText(hired.error)))
      seat = hired.value.slaveId
      roles = hired.value.runtimeRoles
    }
    if (!roles.includes(PACKAGE_WORKER_ROLE)) {
      const granted = await mergeRuntimeRoles(seat, [PACKAGE_WORKER_ROLE], 'conductor', 'system')
      if (!granted.ok) return err(noSeat(pkg, refusalText(granted.error)))
    }
    taken.add(seat)
    seats.set(pkg.key, seat)
  }
  return ok(seats)
}

/** The refusal a person reads: which package went unstaffed, from which persona, and why. */
function noSeat(pkg: Pick<PackageSpec, 'key' | 'templateId'>, reason: string): string {
  return `no seat for package "${pkg.key}" (persona ${pkg.templateId}): ${reason}`
}
