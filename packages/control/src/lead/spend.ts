import { prisma } from '@slave-of-ai/db/client'

/** What one goal version spent, by who spent it. */
export interface GoalSpend {
  readonly totalUsd: number
  /** The lead's sessions, each at its running total (C2); its subordinate sessions' cost is inside it. */
  readonly leadUsd: number
  /** The verification and confirmation runs. */
  readonly proofUsd: number
  /** The conductor's model calls for this version (the requirement extraction). */
  readonly conductorUsd: number
  /** Concluded runs that reported no cost (a cancelled or crashed turn): their spend is not in the sums. */
  readonly unmeasuredRuns: number
}

const sum = (rows: readonly { readonly costUsd: number | null }[]): number => rows.reduce((total, row) => total + (row.costUsd ?? 0), 0)
const round = (usd: number): number => Math.round(usd * 1e6) / 1e6

interface LeadTurnCost {
  readonly id: string
  readonly sessionId: string | null
  readonly costUsd: number | null
  readonly startedAt: Date
  readonly endedAt: Date | null
}

/**
 * Lead-flow C2 (measured 2026-10-04): a resumed session reports its RUNNING total, so a lead
 * turn's `costUsd` already holds every earlier turn of its session. What the lead spent is each
 * session's largest reported total, summed over its sessions; a turn with no session line is a
 * session of its own. A concluded turn with no cost is unmeasured only when no later turn of the
 * same session reported -- a later total includes it.
 */
function leadSpendOf(turns: readonly LeadTurnCost[]): { readonly usd: number; readonly unmeasured: number } {
  const bySession = new Map<string, LeadTurnCost[]>()
  for (const turn of turns) {
    const key = turn.sessionId ?? `run:${turn.id}`
    bySession.set(key, [...(bySession.get(key) ?? []), turn])
  }
  let usd = 0
  let unmeasured = 0
  for (const session of bySession.values()) {
    usd += Math.max(0, ...session.map((turn) => turn.costUsd ?? 0))
    unmeasured += session.filter(
      (turn) => turn.endedAt !== null && turn.costUsd === null && !session.some((later) => later.costUsd !== null && later.startedAt > turn.startedAt),
    ).length
  }
  return { usd, unmeasured }
}

const runsOf = (workspaceId: string, goalVersion: number) =>
  ({
    lead: { leadTurn: { not: null }, task: { workspaceId, workPackage: { goalVersion } } },
    proof: { kind: 'verification' as const, goalDelivery: { workspaceId, goalVersion } },
  }) as const

/**
 * Lead-flow spec B4 (plan A L6, C2): the goal version's spend -- the lead's sessions, the proof
 * runs and the conductor's calls for that version. A proof run is a session of its own, so its
 * cost is its own; a lead turn's is its session's running total ({@link leadSpendOf}). A run's
 * cost is known only once it concluded with a result line; one that ended without, and that no
 * later total covers, is counted in `unmeasuredRuns` and adds nothing.
 */
export async function goalSpend(workspaceId: string, goalVersion: number): Promise<GoalSpend> {
  const where = runsOf(workspaceId, goalVersion)
  const [lead, proof, calls] = await Promise.all([
    prisma.slaveRun.findMany({ where: where.lead, select: { id: true, sessionId: true, costUsd: true, startedAt: true, endedAt: true } }),
    prisma.slaveRun.findMany({ where: where.proof, select: { costUsd: true, endedAt: true } }),
    prisma.conductorCall.aggregate({ where: { workspaceId, goalVersion }, _sum: { modelCostUsd: true } }),
  ])
  const leadSpend = leadSpendOf(lead)
  const leadUsd = round(leadSpend.usd)
  const proofUsd = round(sum(proof))
  const conductorUsd = round(calls._sum.modelCostUsd ?? 0)
  return {
    totalUsd: round(leadUsd + proofUsd + conductorUsd),
    leadUsd,
    proofUsd,
    conductorUsd,
    unmeasuredRuns: leadSpend.unmeasured + proof.filter((run) => run.endedAt !== null && run.costUsd === null).length,
  }
}

/**
 * Lead-flow plan A L7: the working time a goal version has taken -- each of its lead turns and
 * proof runs from start to end (or to `now` while live), less the time it sat paused. The gaps
 * between runs (a wait for the provider, a halt, the daemon down) are not charged.
 */
export async function goalWorkedMs(workspaceId: string, goalVersion: number, now: Date = new Date()): Promise<number> {
  const where = runsOf(workspaceId, goalVersion)
  const runs = await prisma.slaveRun.findMany({
    where: { OR: [where.lead, where.proof] },
    select: { startedAt: true, endedAt: true, pausedMs: true, pausedAt: true },
  })
  return runs.reduce((total, run) => {
    const end = run.endedAt ?? now
    const openPause = run.endedAt === null && run.pausedAt !== null ? Math.max(0, now.getTime() - run.pausedAt.getTime()) : 0
    return total + Math.max(0, end.getTime() - run.startedAt.getTime() - run.pausedMs - openPause)
  }, 0)
}
