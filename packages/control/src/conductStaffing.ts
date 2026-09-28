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
 * `conducted`, a reviewer released since. In order, among open, unreleased seats that hold none of
 * `packageSeats` (this version's package workers) and ran no `implementation` on a task of this
 * version:
 *   1. a seat already holding VERIFIER_ROLE;
 *   2. a reviewer seat, given VERIFIER_ROLE (reviewing is not implementing);
 *   3. a new seat hired from `fallbackTemplateId` (the first package's persona), given the role.
 * Profile only: a verification run gets the persona's profile and no skills (D4), so the persona
 * needs no fit to the work. The refusal names the verifier and the persona it could not hire.
 */
export async function staffVerifier(
  workspaceId: string,
  goalVersion: number,
  packageSeats: ReadonlySet<string>,
  fallbackTemplateId: string,
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

  let seat: string
  const reviewer = eligible.find((s) => s.runtimeRoles.includes(REVIEWER_ROLE))
  if (reviewer !== undefined) {
    seat = reviewer.id
  } else {
    const hired = await hireFromTemplate(workspaceId, fallbackTemplateId, {
      rationale: `Conductor: verifier of goal v${String(goalVersion)}`,
      requirePool: true,
      newSeat: true,
    })
    if (!hired.ok) return err(noVerifier(goalVersion, fallbackTemplateId, refusalText(hired.error)))
    seat = hired.value.slaveId
    if (hired.value.runtimeRoles.includes(VERIFIER_ROLE)) return ok(seat)
  }
  const granted = await mergeRuntimeRoles(seat, [VERIFIER_ROLE], 'conductor', 'system')
  if (!granted.ok) return err(noVerifier(goalVersion, fallbackTemplateId, refusalText(granted.error)))
  return ok(seat)
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

/** The refusal a person reads when no verifier could be staffed: which version, which persona, why. */
function noVerifier(goalVersion: number, templateId: string, reason: string): string {
  return `no verifier seat for goal v${String(goalVersion)} (persona ${templateId}): ${reason}`
}

/** The refusal a person reads: which package went unstaffed, from which persona, and why. */
function noSeat(pkg: Pick<PackageSpec, 'key' | 'templateId'>, reason: string): string {
  return `no seat for package "${pkg.key}" (persona ${pkg.templateId}): ${reason}`
}
