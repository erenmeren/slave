import { prisma } from '@slave-of-ai/db/client'
import { PACKAGE_WORKER_ROLE, REVIEWER_ROLE, VERIFIER_ROLE, err, ok, type PackageSpec, type Result } from '@slave-of-ai/domain'
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
 *
 * The workspace's ONLY reviewer is never reused (final review M2): made a package worker, it would
 * implement a package that then has nobody to review it -- a reviewer is never the implementer.
 * A package of that persona is staffed by a hire instead.
 *
 * A seat holding VERIFIER_ROLE is never reused either (plan 4b D4): the verifier of a goal version
 * must have implemented nothing in it (spec R8), and a package would make it an implementer.
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
  const reviewers = open.filter((s) => s.runtimeRoles.includes(REVIEWER_ROLE))
  const soleReviewer = reviewers.length === 1 ? reviewers[0]?.id : undefined

  const taken = new Set<string>()
  const seats = new Map<string, string>()
  for (const pkg of packages) {
    const reuse = open.find(
      (s) =>
        s.person.templateId === pkg.templateId &&
        !taken.has(s.id) &&
        !holding.has(s.id) &&
        s.id !== soleReviewer &&
        // A verifier is never an implementer (plan 4b D4).
        !s.runtimeRoles.includes(VERIFIER_ROLE),
    )
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

/**
 * The seat that verifies goal version `goalVersion` (spec R8: "a verifier seat that implemented
 * nothing in this goal version"; plan 4b D4). Intake staffs the verifier for a conducted project
 * (spec R5); the conductor makes sure one exists when intake did not -- a workspace switched to
 * `conducted`, a reviewer released since.
 *
 * ELIGIBLE means an open, unreleased seat that holds none of `packageSeats` (this version's
 * package workers) and ran no `implementation` on a task of this version. In order (ruling V3):
 *   1. an eligible seat already holding VERIFIER_ROLE;
 *   2. an eligible reviewer seat, given VERIFIER_ROLE (reviewing is not implementing);
 *   3. any other eligible seat, given VERIFIER_ROLE -- a seat already here costs no pool person;
 *   4. a new seat hired from `personas` in the order given (the conductor passes the plan's
 *      personas, least-used first), the next one when a pool is exhausted;
 *   5. a new seat hired from any active catalogue persona with a free pool slot, by name then id.
 * A seat whose role grant is refused (the runtime-role cap) is passed over, not the end. Steps 4
 * and 5 are what keep a reviewer-less workspace conductable when the plan takes every person of
 * its persona; step 5 is sound because a verification run gets the persona's profile and no skills
 * (D4), so the persona needs no fit to the work. Lowest id wins a tie, as in `staffPackages`. The
 * refusal names everything that was tried.
 */
export async function staffVerifier(
  workspaceId: string,
  goalVersion: number,
  packageSeats: ReadonlySet<string>,
  personas: readonly string[],
): Promise<Result<string, string>> {
  const implementers = await implementersOf(workspaceId, goalVersion)
  const open = await prisma.slave.findMany({
    where: { team: { workspaceId }, closedAt: null, person: { releasedAt: null } },
    select: { id: true, runtimeRoles: true },
    orderBy: { id: 'asc' },
  })
  const eligible = open.filter((s) => !packageSeats.has(s.id) && !implementers.has(s.id))
  const verifier = eligible.find((s) => s.runtimeRoles.includes(VERIFIER_ROLE))
  if (verifier !== undefined) return ok(verifier.id)

  const tried: string[] = []
  // Steps 2 and 3: reviewers first, then every other eligible seat, each given the role.
  const reviewers = eligible.filter((s) => s.runtimeRoles.includes(REVIEWER_ROLE))
  const rest = eligible.filter((s) => !s.runtimeRoles.includes(REVIEWER_ROLE))
  for (const seat of [...reviewers, ...rest]) {
    const granted = await mergeRuntimeRoles(seat.id, [VERIFIER_ROLE], 'conductor', 'system')
    if (granted.ok) return ok(seat.id)
    tried.push(`seat ${seat.id}: ${refusalText(granted.error)}`)
  }
  if (eligible.length === 0) tried.push('no open seat is free of this version\'s work')

  // Step 4: the plan's personas, in the order given.
  const hiredFrom = new Set<string>()
  for (const templateId of new Set(personas)) {
    hiredFrom.add(templateId)
    const hired = await hireVerifier(workspaceId, goalVersion, templateId)
    if (hired.ok) return hired
    tried.push(`persona ${templateId}: ${hired.error}`)
  }

  // Step 5: any active catalogue persona with a free pool slot for this workspace. One query per
  // pick, never a hire per catalogue entry: a hire that finds its pool empty re-syncs the pool.
  for (;;) {
    const free = await prisma.slaveTemplate.findFirst({
      where: {
        active: true,
        id: { notIn: [...hiredFrom] },
        hiredPersons: {
          some: { poolSlot: { not: null }, releasedAt: null, seats: { none: { closedAt: null, team: { workspaceId } } } },
        },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    if (free === null) break
    hiredFrom.add(free.id)
    const hired = await hireVerifier(workspaceId, goalVersion, free.id)
    if (hired.ok) return hired
    tried.push(`persona ${free.id}: ${hired.error}`)
  }
  tried.push('no catalogue persona has a free pool slot')
  return err(`no verifier seat for goal v${String(goalVersion)}: ${tried.join('; ')}`)
}

/** A new seat from `templateId`'s managed pool, holding VERIFIER_ROLE; the error is the reason. */
async function hireVerifier(workspaceId: string, goalVersion: number, templateId: string): Promise<Result<string, string>> {
  const hired = await hireFromTemplate(workspaceId, templateId, {
    rationale: `Conductor: verifier of goal v${String(goalVersion)}`,
    requirePool: true,
    newSeat: true,
  })
  if (!hired.ok) return err(refusalText(hired.error))
  if (hired.value.runtimeRoles.includes(VERIFIER_ROLE)) return ok(hired.value.slaveId)
  const granted = await mergeRuntimeRoles(hired.value.slaveId, [VERIFIER_ROLE], 'conductor', 'system')
  if (!granted.ok) return err(refusalText(granted.error))
  return ok(hired.value.slaveId)
}

/**
 * The seats that implemented goal version `goalVersion`: every slave with an `implementation` run
 * on a task of one of the version's packages. Such a seat never verifies that version (spec R8).
 */
export async function implementersOf(workspaceId: string, goalVersion: number): Promise<ReadonlySet<string>> {
  const runs = await prisma.slaveRun.findMany({
    where: { kind: 'implementation', task: { workspaceId, workPackage: { goalVersion } } },
    select: { slaveId: true },
    distinct: ['slaveId'],
  })
  return new Set(runs.map((run) => run.slaveId))
}

/** The refusal a person reads: which package went unstaffed, from which persona, and why. */
function noSeat(pkg: Pick<PackageSpec, 'key' | 'templateId'>, reason: string): string {
  return `no seat for package "${pkg.key}" (persona ${pkg.templateId}): ${reason}`
}
