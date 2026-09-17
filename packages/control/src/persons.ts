import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { NON_TERMINAL_RUN_STATUSES, TERMINAL, err, ok, type Result, type SlaveLifecycle } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { ProviderKind } from '@slave-of-ai/providers'
import { uniquePersonName } from './capability.js'
import { collectTaskWorktree } from './collect.js'
import { isProviderKind } from './org.js'
import type { Principal } from './principal.js'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import { refusalText, type ControlRefusal } from './refusal.js'

/** How much of a release or removal reason is stored -- `lifecycle.ts`'s own cap, restated here
 *  rather than exported across a boundary for one number. */
const REASON_MAX = 500
const REASON_FALLBACK = 'released'

/**
 * A run that is still going, ANYWHERE this person sits (R13, R14).
 *
 * The one refusal `unassignPerson` and `deletePerson` share, and the reason it is its own helper:
 * `liveRunCount` counts against a workspace, a team or ONE seat, and the whole point of a person is
 * that their runs are spread across projects the caller may not be looking at.
 */
async function personRunInProgress(
  tx: Prisma.TransactionClient,
  personId: string,
  teamId?: string,
): Promise<{ readonly runId: string } | null> {
  const run = await tx.slaveRun.findFirst({
    where: {
      status: { in: [...NON_TERMINAL_RUN_STATUSES] },
      slave: { personId, ...(teamId === undefined ? {} : { teamId }) },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  return run === null ? null : { runId: run.id }
}

/** The pair rule, restated for this file's own creation path: a model means nothing without the
 *  provider that runs it (`org.ts`'s `pairRefusal`, same rule, same refusal kind). */
function pairRefusal(model: string | undefined, provider: string | undefined): ControlRefusal | null {
  return (model !== undefined) !== (provider !== undefined) ? { kind: 'model_without_provider' } : null
}

/**
 * A new PERSON (R10). From a persona, or from nothing at all -- and in neither case does a project
 * or a department have to exist first, which is the operator's first ask in one function.
 *
 * The person lands in the POOL, which is not a column: no seat and no `releasedAt` IS the pool
 * (R6). `assignPerson` is what puts them to work, later, somewhere, or never.
 *
 * The name defaults to the persona's, and a taken name gets ` 2`, ` 3` -- `uniquePersonName`, the
 * SAME rule `hireFromTemplate` has always used, so the two creation paths cannot name people
 * differently. `person_name_taken` is still a refusal this returns: the suffix loop closes the
 * ordinary collision, and the unique index closes the race the loop cannot (two callers reading the
 * same taken set), which is caught below exactly as `org.ts`'s catalog verbs catch theirs.
 */
export async function createPerson(
  input: {
    readonly templateId?: string
    readonly name?: string
    readonly profile?: string
    readonly model?: string
    readonly provider?: ProviderKind
    readonly capabilities?: readonly string[]
    readonly lifecycle?: SlaveLifecycle
  },
  principal?: Principal,
): Promise<Result<{ readonly personId: string; readonly name: string }, ControlRefusal>> {
  if (input.provider !== undefined && !isProviderKind(input.provider)) {
    return err({ kind: 'invalid_provider', provider: input.provider })
  }
  const pair = pairRefusal(input.model, input.provider)
  if (pair !== null) return err(pair)

  const template =
    input.templateId === undefined
      ? null
      : await prisma.slaveTemplate.findUnique({
          where: { id: input.templateId },
          select: { id: true, name: true, capabilityKeys: true },
        })
  if (input.templateId !== undefined && template === null) {
    return err({ kind: 'template_not_found', templateId: input.templateId })
  }

  const wanted = (input.name ?? template?.name ?? '').trim()
  if (wanted === '') return err({ kind: 'invalid_name', detail: 'a slave needs a name, or a persona to take one from' })

  const name = uniquePersonName(await prisma.person.findMany({ select: { name: true } }), wanted)
  try {
    const person = await prisma.person.create({
      data: {
        name,
        ...(template === null ? {} : { templateId: template.id }),
        ...(input.profile === undefined ? {} : { profile: input.profile }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        capabilities: [...(input.capabilities ?? template?.capabilityKeys ?? [])],
        ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
      },
    })
    // NO event: a person belongs to no workspace, and `appendEvent`'s envelope needs one. The same
    // silence every catalog verb keeps, for the same reason (`addDepartmentMember`, `createTemplate`).
    void principal
    return ok({ personId: person.id, name: person.name })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'person_name_taken', name })
    throw error
  }
}

/**
 * Opens a SEAT for a person on a project team (R10).
 *
 * FIND-OR-REOPEN, never a second row: `@@unique([personId, teamId])` is the invariant, and a seat
 * that `unassignPerson` closed is reopened here with its runs, messages and permissions still
 * attached -- which is what R2 means by "keeps its history and is CLOSED, not deleted".
 *
 * The role defaults to the persona's, then to `worker`: a seat must have one because the review and
 * planning passes render it, and refusing a seating for want of a title would be a refusal about
 * nothing. `runtimeRoles` defaults to that same role, which is what makes the person dispatchable
 * the moment they sit down.
 *
 * Person-first lock, same order as `hireFromTemplate` / `setPersonCapabilities`: the `releasedAt`
 * check and any seat reopen both run under it, so a concurrent `releasePerson` cannot leave an
 * open seat on a released person.
 */
export async function assignPerson(
  personId: string,
  teamId: string,
  options?: {
    readonly role?: string
    readonly runtimeRoles?: readonly string[]
    readonly engagementTaskId?: string | null
  },
  principal?: Principal,
): Promise<Result<{ readonly slaveId: string; readonly reopened: boolean }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
    const person = await tx.person.findUnique({
      where: { id: personId },
      include: { template: { select: { role: true } } },
    })
    if (person === null) return { refusal: { kind: 'person_not_found', personId } as ControlRefusal }
    if (person.releasedAt !== null) {
      return { refusal: { kind: 'person_released', personId, at: person.releasedAt.toISOString() } as ControlRefusal }
    }
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { id: true, name: true, workspaceId: true } })
    if (team === null) return { refusal: { kind: 'team_not_found', teamId } as ControlRefusal }

    const existing = await tx.slave.findUnique({ where: { personId_teamId: { personId, teamId } } })
    if (existing !== null && existing.closedAt === null) {
      return { refusal: { kind: 'already_assigned', personId, teamId } as ControlRefusal }
    }

    const role = options?.role ?? person.template?.role ?? 'worker'
    const runtimeRoles = [...new Set(options?.runtimeRoles ?? [role])]
    if (existing !== null) {
      await tx.slave.update({
        where: { id: existing.id },
        data: {
          closedAt: null,
          role,
          runtimeRoles,
          ...(options?.engagementTaskId === undefined ? {} : { engagementTaskId: options.engagementTaskId }),
        },
      })
      return { slaveId: existing.id, reopened: true, workspaceId: team.workspaceId, name: person.name, team: team.name }
    }

    const seat = await tx.slave.create({
      data: {
        teamId,
        personId,
        role,
        runtimeRoles,
        ...(options?.engagementTaskId === undefined || options.engagementTaskId === null
          ? {}
          : { engagementTaskId: options.engagementTaskId }),
      },
    })
    return { slaveId: seat.id, reopened: false, workspaceId: team.workspaceId, name: person.name, team: team.name }
  })
  if ('refusal' in outcome) return err(outcome.refusal)

  await appendEvent({
    type: 'org.changed',
    workspaceId: outcome.workspaceId,
    slaveId: outcome.slaveId,
    actor: 'human',
    payload: {
      entity: 'slave',
      id: outcome.slaveId,
      field: 'created',
      from: null,
      to: `${outcome.name} on ${outcome.team}`,
      personId,
    },
    userId: principal?.userId ?? null,
  })
  return ok({ slaveId: outcome.slaveId, reopened: outcome.reopened })
}

/**
 * CLOSES a seat (R10). Never a delete: the runs, the messages and the permissions this person
 * produced on this project are the record, and `deletePerson` (R13) is the verb that means "all of
 * it goes".
 *
 * The refusal is `run_in_progress`, scoped to THIS seat: a person running on another project is not
 * a reason to keep them on this one.
 */
export async function unassignPerson(
  personId: string,
  teamId: string,
  options: { readonly reason: string },
  principal?: Principal,
): Promise<Result<{ readonly slaveId: string }, ControlRefusal>> {
  const reason = (options.reason.trim() === '' ? 'removed from the project' : options.reason.trim()).slice(0, REASON_MAX)
  const outcome = await prisma.$transaction(async (tx) => {
    const seat = await tx.slave.findUnique({
      where: { personId_teamId: { personId, teamId } },
      include: { team: { select: { workspaceId: true, name: true } }, person: { select: { name: true } } },
    })
    if (seat === null || seat.closedAt !== null) {
      return { refusal: { kind: 'person_not_seated', personId, teamId } as ControlRefusal }
    }
    const live = await personRunInProgress(tx, personId, teamId)
    if (live !== null) return { refusal: { kind: 'run_in_progress', personId, runId: live.runId } as ControlRefusal }

    await tx.slave.update({ where: { id: seat.id }, data: { closedAt: new Date(), runtimeRoles: [] } })
    return { slaveId: seat.id, workspaceId: seat.team.workspaceId, name: seat.person.name, team: seat.team.name, reason }
  })
  if ('refusal' in outcome) return err(outcome.refusal)

  await appendEvent({
    type: 'org.changed',
    workspaceId: outcome.workspaceId,
    slaveId: outcome.slaveId,
    actor: 'human',
    payload: { entity: 'slave', id: outcome.slaveId, field: 'team', from: outcome.team, to: null, personId },
    userId: principal?.userId ?? null,
  })
  return ok({ slaveId: outcome.slaveId })
}

/**
 * Close one seat and open another, in ONE transaction (R10).
 *
 * Not `unassignPerson` then `assignPerson`: those are two transactions, and a failure between them
 * leaves a person nowhere. Every refusal here is decided BEFORE the first write, so all of them are
 * returned values -- and the one that cannot be (a unique-index race on the target seat) is thrown
 * by Prisma itself and caught below, which is what makes the close roll back with it.
 */
export async function movePerson(
  personId: string,
  fromTeamId: string,
  toTeamId: string,
  principal?: Principal,
): Promise<Result<{ readonly slaveId: string }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
    const person = await tx.person.findUnique({
      where: { id: personId },
      select: { releasedAt: true },
    })
    if (person === null) return { refusal: { kind: 'person_not_found', personId } as ControlRefusal }
    if (person.releasedAt !== null) {
      return { refusal: { kind: 'person_released', personId, at: person.releasedAt.toISOString() } as ControlRefusal }
    }
    const from = await tx.slave.findUnique({
      where: { personId_teamId: { personId, teamId: fromTeamId } },
      include: { team: { select: { workspaceId: true, name: true } } },
    })
    if (from === null || from.closedAt !== null) {
      return { refusal: { kind: 'person_not_seated', personId, teamId: fromTeamId } as ControlRefusal }
    }
    const to = await tx.team.findUnique({ where: { id: toTeamId }, select: { id: true, name: true, workspaceId: true } })
    if (to === null) return { refusal: { kind: 'team_not_found', teamId: toTeamId } as ControlRefusal }
    const existing = await tx.slave.findUnique({ where: { personId_teamId: { personId, teamId: toTeamId } } })
    if (existing !== null && existing.closedAt === null) {
      return { refusal: { kind: 'already_assigned', personId, teamId: toTeamId } as ControlRefusal }
    }
    const live = await personRunInProgress(tx, personId, fromTeamId)
    if (live !== null) return { refusal: { kind: 'run_in_progress', personId, runId: live.runId } as ControlRefusal }

    await tx.slave.update({ where: { id: from.id }, data: { closedAt: new Date(), runtimeRoles: [] } })
    const seat =
      existing === null
        ? await tx.slave.create({
            data: { teamId: toTeamId, personId, role: from.role, runtimeRoles: from.runtimeRoles },
          })
        : await tx.slave.update({
            where: { id: existing.id },
            data: { closedAt: null, role: from.role, runtimeRoles: from.runtimeRoles },
          })
    return { slaveId: seat.id, workspaceId: to.workspaceId, from: from.team.name, to: to.name }
  })
  if ('refusal' in outcome) return err(outcome.refusal)

  await appendEvent({
    type: 'org.changed',
    workspaceId: outcome.workspaceId,
    slaveId: outcome.slaveId,
    actor: 'human',
    payload: { entity: 'slave', id: outcome.slaveId, field: 'team', from: outcome.from, to: outcome.to, personId },
    userId: principal?.userId ?? null,
  })
  return ok({ slaveId: outcome.slaveId })
}

/**
 * The end of a person's engagement (R10, R21). Closes EVERY seat and stamps `releasedAt`.
 *
 * `releaseWorker`'s successor, and it keeps that verb's whole discipline: the reason is normalised
 * before the transaction so the column and the event cannot disagree; the empty runtime-role set on
 * every closed seat is the whole of how a released person stops being dispatched; the worktrees are
 * collected AFTER the commit, one `try` each, because `collectTaskWorktree` opens its own
 * transaction and the two must never nest (ADR 0003).
 *
 * History is kept. Every run, message, permission and memory stays exactly where it was.
 *
 * Person-first lock, same order as `hireFromTemplate` / `setPersonCapabilities`: `releasedAt` is
 * stamped under it, so a concurrent reuse cannot miss the release because the Person row was never
 * locked. The seat is not locked first.
 *
 * **The managed pool slot is VACATED in the same update** (final review, Important 3). A release
 * makes somebody permanently ineligible -- `selectPoolPerson` filters on `releasedAt: null` -- but
 * leaving `poolSlot` set left the slot OCCUPIED by somebody nothing can ever pick, so
 * `syncPersonPool` reported all three slots `unchanged` over a pool that was empty in every sense
 * that matters and the template became permanently unstaffable. Clearing it in the same locked
 * write is what makes the slot available: a later sync creates a NEW managed identity for it if
 * the template is still active, and creates nothing if it is not. Nobody is un-released to fill a
 * slot, and this person keeps everything else -- their name, their capabilities, their grants,
 * every closed seat and every run.
 */
export async function releasePerson(
  personId: string,
  reason: string,
  principal?: Principal,
  origin: 'human' | 'system' = 'human',
): Promise<Result<{ readonly seatsClosed: number; readonly worktreesCollected: number }, ControlRefusal>> {
  const trimmed = reason.trim()
  const recorded = (trimmed === '' ? REASON_FALLBACK : trimmed).slice(0, REASON_MAX)

  const plan = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
    const person = await tx.person.findUnique({
      where: { id: personId },
      include: { seats: { where: { closedAt: null }, include: { team: { select: { workspaceId: true } } } } },
    })
    if (person === null) return { refusal: { kind: 'person_not_found', personId } as ControlRefusal }
    if (person.releasedAt !== null) {
      return { refusal: { kind: 'already_released', slaveId: personId, at: person.releasedAt.toISOString() } as ControlRefusal }
    }
    const live = await personRunInProgress(tx, personId)
    if (live !== null) return { refusal: { kind: 'run_in_progress', personId, runId: live.runId } as ControlRefusal }

    const now = new Date()
    await tx.person.update({
      where: { id: personId },
      data: { releasedAt: now, releaseReason: recorded, poolSlot: null },
    })
    const closed = await tx.slave.updateMany({
      where: { personId, closedAt: null },
      data: { closedAt: now, runtimeRoles: [] },
    })
    const runs = await tx.slaveRun.findMany({
      where: { slave: { personId }, worktreePath: { not: null }, task: { status: { in: [...TERMINAL] } } },
      select: { taskId: true },
      orderBy: { id: 'asc' },
    })
    return {
      seatsClosed: closed.count,
      name: person.name,
      seats: person.seats.map((seat) => ({ slaveId: seat.id, workspaceId: seat.team.workspaceId })),
      taskIds: [...new Set(runs.flatMap((run) => (run.taskId === null ? [] : [run.taskId])))],
    }
  })
  if ('refusal' in plan) return err(plan.refusal)

  let worktreesCollected = 0
  for (const taskId of plan.taskIds) {
    try {
      const collected = await collectTaskWorktree(taskId, 'released', principal)
      if (collected.ok) worktreesCollected += 1
      else console.warn(`releasePerson: leaving task ${taskId}'s worktree in place: ${refusalText(collected.error)}`)
    } catch (error) {
      console.warn(
        `releasePerson: leaving task ${taskId}'s worktree in place: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // One event per project the person was on: `slave.released`'s envelope needs a workspace AND
  // the seat that project closed, so a feed keyed on the worker (and gate:m50's
  // `slaveId: hiredId`) still finds the row. The payload names the PERSON (`slaveId` there is
  // the person, with `personId` beside it) -- two ids, one fact.
  const seenWorkspaces = new Set<string>()
  for (const seat of plan.seats) {
    if (seenWorkspaces.has(seat.workspaceId)) continue
    seenWorkspaces.add(seat.workspaceId)
    await appendEvent({
      type: 'slave.released',
      workspaceId: seat.workspaceId,
      slaveId: seat.slaveId,
      actor: origin,
      payload: { slaveId: personId, name: plan.name, reason: recorded, worktreesCollected, personId },
      userId: principal?.userId ?? null,
    })
  }
  return ok({ seatsClosed: plan.seatsClosed, worktreesCollected })
}

/** What a delete WOULD take, for the confirmation a person reads first (R13). A read, so no
 *  `Result`: the one thing that can go wrong is the person being gone, which is `null`. */
export async function personFootprint(
  personId: string,
): Promise<{ readonly name: string; readonly projects: readonly string[]; readonly runs: number } | null> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: { seats: { include: { team: { include: { workspace: { select: { name: true } } } } } } },
  })
  if (person === null) return null
  const runs = await prisma.slaveRun.count({ where: { slave: { personId } } })
  return {
    name: person.name,
    projects: [...new Set(person.seats.map((seat) => seat.team.workspace.name))].toSorted((a, b) => a.localeCompare(b)),
    runs,
  }
}

/**
 * DELETE DELETES (R13). The person, every seat, and by cascade every run, checkpoint, message,
 * permission and memory they own -- exactly what deleting a slave did before this milestone, now
 * across however many projects they were on.
 *
 * ONE refusal: a run in progress, on ANY seat. That is the operator's own ruling (D5) and the
 * reason there is no softer delete here: "remove from this project only" is `unassignPerson`, a
 * separate and explicit act.
 *
 * `projects` comes back so the CLI and the UI can say what went. Read INSIDE the transaction,
 * before the delete, because after it there is nothing to ask.
 */
export async function deletePerson(
  personId: string,
  principal?: Principal,
): Promise<
  Result<
    {
      readonly seats: number
      readonly runs: number
      readonly memories: number
      readonly projects: readonly string[]
    },
    ControlRefusal
  >
> {
  const outcome = await prisma.$transaction(async (tx) => {
    const person = await tx.person.findUnique({
      where: { id: personId },
      include: { seats: { include: { team: { include: { workspace: { select: { id: true, name: true } } } } } } },
    })
    if (person === null) return { refusal: { kind: 'person_not_found', personId } as ControlRefusal }
    const live = await personRunInProgress(tx, personId)
    if (live !== null) return { refusal: { kind: 'run_in_progress', personId, runId: live.runId } as ControlRefusal }

    const runs = await tx.slaveRun.count({ where: { slave: { personId } } })
    const memories = await tx.memory.count({ where: { personId } })
    const projects = [...new Set(person.seats.map((seat) => seat.team.workspace.name))].toSorted((a, b) =>
      a.localeCompare(b),
    )
    const workspaceIds = [...new Set(person.seats.map((seat) => seat.team.workspace.id))]
    const seatIds = person.seats.map((seat) => seat.id)

    // `Person` cascades `Slave`, which cascades `SlaveRun` (and `Checkpoint`), `SlavePermission`
    // and `SlaveMessage`; `Person` cascades `PersonSkill`, `CompanyTeamMember` and `Memory`
    // directly. `ExecutionEvent.slaveId` has no FK and keeps its value -- the activity feed already
    // renders a past event from its payload and tolerates a row it can no longer resolve.
    await tx.person.delete({ where: { id: personId } })
    return { seats: person.seats.length, runs, memories, projects, workspaceIds, seatIds, name: person.name }
  })
  if ('refusal' in outcome) return err(outcome.refusal)

  for (const [index, workspaceId] of outcome.workspaceIds.entries()) {
    await appendEvent({
      type: 'org.changed',
      workspaceId,
      actor: 'human',
      payload: {
        entity: 'person',
        id: personId,
        field: 'deleted',
        from: outcome.name,
        to: null,
        runs: index === 0 ? outcome.runs : 0,
        personId,
      },
      userId: principal?.userId ?? null,
    })
  }
  return ok({ seats: outcome.seats, runs: outcome.runs, memories: outcome.memories, projects: outcome.projects })
}
