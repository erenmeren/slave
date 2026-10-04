import { ensureLeadSeats, refusalText } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { INITIAL_LEAD_PROGRESS, LEAD_TEMPLATE_ID, integrationBranchName, requirementItemsSchema, singlePlan } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { AlreadyConducted, materialise, tripConductor, type ConductStep } from '../conductor.js'
import { ensureIntegrationBranch } from '../goalBranch.js'
import { progressJson } from './record.js'

/**
 * Lead-flow spec B1 (plan A L3): a goal version's plan in the lead flow -- one package that owns
 * everything and one task for the lead, by rule, with no model call. The conductor's own
 * `materialise` writes it, so the version has its delivery row, its work branch and its recorded
 * decision exactly as a `single` plan does; the lead and the verifier are the project's system
 * seats. A problem a later tick may fix (a branch that cannot be cut) is said once and tried again.
 */
export async function openLeadGoal(
  workspaceId: string,
  workspace: { readonly repoPath: string; readonly baseBranch: string; readonly maxAttempts: number },
  version: number,
  storedItems: Prisma.JsonValue,
): Promise<ConductStep> {
  const items = requirementItemsSchema.parse(storedItems)
  const seats = await ensureLeadSeats(workspaceId)
  if (!seats.ok) {
    await tripConductor(workspaceId, `goal v${String(version)} could not be opened in the lead flow: ${refusalText(seats.error)}`)
    return 'conduct_failed'
  }
  const plan = singlePlan(LEAD_TEMPLATE_ID, items.map((item) => item.key), 'lead flow: one lead builds the whole goal')
  const integrationBranch = integrationBranchName(version, workspaceId)
  let cut: { readonly baseCommit: string }
  try {
    cut = await ensureIntegrationBranch(workspace.repoPath, workspace.baseBranch, integrationBranch)
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
    await tripConductor(workspaceId, `goal v${String(version)} could not cut its work branch: ${message}`)
    return 'conduct_failed'
  }
  try {
    await materialise(workspaceId, version, workspace.maxAttempts, plan, true, new Map([['main', seats.value.lead]]), items, {
      integrationBranch,
      baseCommit: cut.baseCommit,
      verifierSlaveId: seats.value.verifier,
    })
  } catch (error) {
    if (error instanceof AlreadyConducted) return 'none'
    throw error
  }
  // After the plan's own transaction: a crash between the two leaves `leadState` null, and the goal
  // pass's `syncLeadStates` (Task 8) writes it.
  const marked = await prisma.goalDelivery.updateMany({
    where: { workspaceId, goalVersion: version, leadState: null },
    data: { leadState: 'building', leadProgress: progressJson(INITIAL_LEAD_PROGRESS) },
  })
  if (marked.count > 0) await appendEvent({ type: 'workspace.lead_state', workspaceId, actor: 'system', payload: { version, state: 'building', reason: null } })
  return 'conducted'
}
