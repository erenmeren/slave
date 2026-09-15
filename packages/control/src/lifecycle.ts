import { prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result, type SlaveLifecycle } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
import { type ControlRefusal } from './refusal.js'
import { liveRunCount } from './workspace.js'

// M58 R10: `releaseWorker` moved to `packages/control/src/persons.ts` as `releasePerson`, because
// a release is a fact about a PERSON and closes every seat they hold, which a verb keyed on one
// seat could not say.

/**
 * A person moves somebody between lifecycles (M50 R4, on `Person` since M58 R1). The ONLY path that
 * changes the column after creation: nothing promotes anybody automatically, and a tick that did
 * would be the Supervisor deciding who works here.
 *
 * Human-only by construction (plan decision D11): no `origin`, no `carryOut` arm, no Supervisor
 * action, `actor: 'human'` on the event -- the shape `renameSlave` and `setSlaveRole` already have.
 *
 * Leaving `ephemeral` clears the engagement AND the release with it: a worker that is no longer
 * temporary has no one assignment to be over, and a `releasedAt` left behind would keep it off every
 * roster while its lifecycle said it belonged there. Nothing is restored -- the runtime roles are a
 * person's own call through `set-runtime-roles`, which is exactly what R4 says.
 *
 * Moving INTO `ephemeral` writes no engagement, deliberately (fix round 1, Minor 4): such a worker
 * never raises `engagement_over` -- the rule needs a terminal engagement task -- and the person who
 * labelled it releases it themselves with `release-worker`, which asks for no engagement.
 */
export async function setLifecycle(
  personId: string,
  lifecycle: SlaveLifecycle,
  principal?: Principal,
): Promise<Result<{ readonly from: SlaveLifecycle; readonly to: SlaveLifecycle }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
    const person = await tx.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        lifecycle: true,
        departments: { select: { companyTeamId: true } },
        // M58 R1: the lifecycle is the person's, so the live-run check is over every seat they hold
        // and the event is written per seat -- an event stream is workspace-scoped and a person is
        // not. A person with no open seat changes lifecycle silently, which is honest: there is no
        // project log to write it to.
        seats: { where: { closedAt: null }, select: { id: true, team: { select: { workspaceId: true } } }, orderBy: { id: 'asc' } },
      },
    })
    if (person === null) return { refusal: { kind: 'person_not_found', personId } as ControlRefusal }
    for (const seat of person.seats) {
      const live = await liveRunCount(tx, { slaveId: seat.id })
      if (live > 0) {
        return { refusal: { kind: 'live_runs', entity: 'slave', id: seat.id, runs: live } as ControlRefusal }
      }
    }
    // The no-move BEFORE the department check (fix round 1, Minor 1): a person whose department was
    // deleted is still permanent -- and asking for the lifecycle they already have must be the
    // no-op it is, never a refusal about a change nobody made.
    const from = person.lifecycle
    if (from === lifecycle) return { seats: person.seats, from, changed: false as const }
    // `permanent` is not a label somebody may apply: it MEANS "this person is in a department of a
    // company" (M58 R5), and a membership is the only thing that can say so.
    if (lifecycle === 'permanent' && person.departments.length === 0) {
      return { refusal: { kind: 'not_in_roster', personId } as ControlRefusal }
    }
    await tx.person.update({
      where: { id: personId },
      data: {
        lifecycle,
        ...(from === 'ephemeral' ? { releasedAt: null, releaseReason: null } : {}),
      },
    })
    if (from === 'ephemeral') {
      await tx.slave.updateMany({ where: { personId, closedAt: null }, data: { engagementTaskId: null } })
    }
    return { seats: person.seats, from, changed: true as const }
  })
  if ('refusal' in outcome) return err(outcome.refusal)

  if (outcome.changed) {
    for (const seat of outcome.seats) {
      await appendEvent({
        type: 'org.changed',
        workspaceId: seat.team.workspaceId,
        slaveId: seat.id,
        actor: 'human',
        payload: { entity: 'slave', id: seat.id, personId, field: 'lifecycle', from: outcome.from, to: lifecycle },
        userId: principal?.userId ?? null,
      })
    }
  }

  return ok({ from: outcome.from, to: lifecycle })
}
