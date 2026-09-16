import { prisma } from '@slave-of-ai/db/client'
import { type GuardrailKind, type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { pauseActiveRuns } from './pause.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

export interface EmergencyStopReport {
  readonly engaged: boolean // false when the workspace was already halted
  readonly requested: readonly string[]
  readonly refused: readonly string[]
}

/**
 * Halt a workspace's scheduling AND pause every active run in it -- the operator's "stop
 * everything now" button (spec §6).
 *
 * An already-halted workspace is NOT a refusal: the operator smashing STOP twice deserves the
 * pause fan-out again (in case a run started, or lost a race, since the first press), not an
 * error.
 */
export async function emergencyStop(
  workspaceId: string,
  requestedBy: string,
  principal?: Principal,
): Promise<Result<EmergencyStopReport, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  // First-writer-wins, mirroring `pump.ts`'s gate-failure halt: conditioned on `haltedReason`
  // still being null so the *first* engagement is the one that explains the workspace's state,
  // and `haltedAt` is the moment of that transition. `world.ts` derives `emergencyStopped` from
  // this column alone, so scheduling stops with zero further work the instant this lands.
  const halted = await prisma.workspace.updateMany({
    where: { id: workspaceId, haltedReason: null },
    data: { haltedReason: `emergency stop by ${requestedBy}`, haltedAt: new Date() },
  })
  const engaged = halted.count === 1

  if (engaged) {
    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId,
      actor: 'human', // an operator did this, not the system
      payload: { guardrail: 'emergency_stop' satisfies GuardrailKind, detail: `engaged by ${requestedBy}` },
      userId: principal?.userId ?? null,
    })
  }

  // Partial failure tolerated: the halt stands regardless of which runs could or could not be
  // paused. A run that lost the race to conclude, or was already pause_requested, belongs in
  // `refused`, not in an exception that would leave the rest of the fan-out un-attempted.
  const { requested, refused } = await pauseActiveRuns(workspaceId, requestedBy, 'emergency_stop')

  return ok({ engaged, requested, refused })
}

/**
 * Retract a safety halt (M57 R14c, plan erratum E1).
 *
 * This is not new behaviour: `apps/orchestrator/src/cli.ts`'s `clear-halt` case has written these
 * exact two columns inline since M5. It moves here so that the CLI and the web route share one
 * copy rather than owning two, which is the whole of the change.
 *
 * IT APPENDS NO EVENT, because the CLI's version appends none, and a milestone whose claim is that
 * nothing changed may not start writing history the CLI does not write. (`emergencyStop` above
 * appends `guardrail.tripped` on the way IN; the way out has always been silent, and whether that
 * asymmetry is right is a question for a milestone that is allowed to answer it.)
 *
 * It STARTS NOTHING: it removes the reason nothing was starting. A paused run resumes when the
 * sweep next reaches it, or when somebody presses Resume.
 *
 * "Removes the reason" is the promise, and for a DERIVED halt it takes `haltClearedAt` to keep it.
 * `emergency_stop` is a stored reason and clearing the column is the whole of it, but the circuit
 * breaker is recomputed from the most recent runs on every tick: without the stamp, clearing a
 * breaker halt lasts until the next tick reads the same three failures and halts again, and since
 * the halt is what prevents the run that would break the streak, the project can never start
 * anything again. The stamp is where the breaker counts from, so failures the operator has
 * already answered for stop counting and anything that fails after it starts a new streak.
 */
export async function clearHalt(workspaceId: string): Promise<Result<{ readonly cleared: boolean }, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { haltedReason: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  // Stamped unconditionally, unlike the two columns below: an operator who clears a workspace that
  // is not halted yet -- having just fixed what was failing, before the third failure trips it --
  // means the same thing by it, and the idempotence this function promises should not depend on
  // winning a race with the tick.
  await prisma.workspace.update({ where: { id: workspaceId }, data: { haltClearedAt: new Date() } })
  // `updateMany` with the condition in the WHERE, not a read-then-write: two operators clearing at
  // once must not both claim to have been the one who did it.
  const cleared = await prisma.workspace.updateMany({
    where: { id: workspaceId, haltedReason: { not: null } },
    data: { haltedReason: null, haltedAt: null },
  })
  // A workspace that was not halted is NOT a refusal -- the button is idempotent by design, the
  // same way `emergencyStop` treats a second press.
  return ok({ cleared: cleared.count === 1 })
}
