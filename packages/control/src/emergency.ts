import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { pauseActiveRuns } from './pause.js'
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
      payload: { guardrail: 'emergency_stop', detail: `engaged by ${requestedBy}` },
    })
  }

  // Partial failure tolerated: the halt stands regardless of which runs could or could not be
  // paused. A run that lost the race to conclude, or was already pause_requested, belongs in
  // `refused`, not in an exception that would leave the rest of the fan-out un-attempted.
  const { requested, refused } = await pauseActiveRuns(workspaceId, requestedBy, 'emergency_stop')

  return ok({ engaged, requested, refused })
}
