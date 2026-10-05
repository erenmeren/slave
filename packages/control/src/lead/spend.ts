import { prisma, type Prisma } from '@slave-of-ai/db/client'

/** What one goal version spent, by who spent it. */
export interface GoalSpend {
  readonly totalUsd: number
  /** The lead's turns, each at its own spend (C2, final review), summed; its subordinate sessions' cost is inside it. */
  readonly leadUsd: number
  /** The verification and confirmation runs. */
  readonly proofUsd: number
  /** The conductor's model calls for this version (the requirement extraction). */
  readonly conductorUsd: number
  /** Concluded runs that reported no cost (a cancelled or crashed turn), and no later total of its
   *  session covers it (C2): their spend is not in the sums. */
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
 * Lead-flow C2 (measured 2026-10-04, final review): a resumed session reports its RUNNING total, and
 * the pump stores on each lead turn's row only its OWN part of it -- the reported total less the
 * earlier turns of the session (`leadTurnOwnCostUsd`) -- so the rows are summed, as every other
 * reader of `SlaveRun.costUsd` sums them. A turn with no session line is a session of its own. A
 * concluded turn with no cost is unmeasured only when no later turn of the same session reported:
 * that later turn's figure holds its spend.
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
    usd += sum(session)
    unmeasured += session.filter(
      (turn) => turn.endedAt !== null && turn.costUsd === null && !session.some((later) => later.costUsd !== null && later.startedAt > turn.startedAt),
    ).length
  }
  return { usd, unmeasured }
}

/** The two kinds of run a goal version's spend and time are made of: its lead turns and its proof runs. */
interface GoalRunFilters {
  readonly lead: Prisma.SlaveRunWhereInput
  readonly proof: Prisma.SlaveRunWhereInput
}

const runsOf = (workspaceId: string, goalVersion: number): GoalRunFilters => ({
  lead: { leadTurn: { not: null }, task: { workspaceId, workPackage: { goalVersion } } },
  proof: { kind: 'verification', goalDelivery: { workspaceId, goalVersion } },
})

/**
 * Lead-flow spec B4 (plan A L6, C2): the goal version's spend -- the lead's sessions, the proof
 * runs and the conductor's calls for that version. A proof run is a session of its own, so its
 * cost is its own; a lead turn's row holds its own part of its session's running total
 * ({@link leadSpendOf}). A run's cost is known only once it concluded with a result line; one that
 * ended without, and that no later turn of its session covers, is counted in `unmeasuredRuns` and
 * adds nothing.
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
 * proof runs from start to end (or to `now` while live), less the time it sat paused (closed spans
 * in `pausedMs`, and one still open at its end or now). The gaps
 * between runs (a wait for the provider, a halt, the daemon down) are not charged.
 *
 * Final review (L7): neither is the downtime INSIDE a run the daemon lost. A run the sweep found
 * dead after a restart (`reconcileOrphans`, `concludeDeadRun`) is concluded `failed`, `platform`,
 * with no cost, and its `endedAt` is when the sweep found it -- the daemon's downtime included. Such
 * a run is counted up to the last sign of life it gave (`lastOutputAt`, else the sweep's last
 * observation, else its start), never past its `endedAt`.
 */
export async function goalWorkedMs(workspaceId: string, goalVersion: number, now: Date = new Date()): Promise<number> {
  const where = runsOf(workspaceId, goalVersion)
  const runs = await prisma.slaveRun.findMany({
    where: { OR: [where.lead, where.proof] },
    select: { startedAt: true, endedAt: true, pausedMs: true, pausedAt: true, status: true, failureClass: true, costUsd: true, lastOutputAt: true, observedAt: true },
  })
  return runs.reduce((total, run) => {
    const lost = run.endedAt !== null && run.status === 'failed' && run.failureClass === 'platform' && run.costUsd === null
    const lastSign = run.lastOutputAt ?? run.observedAt ?? run.startedAt
    const end = run.endedAt === null ? now : lost && lastSign < run.endedAt ? lastSign : run.endedAt
    // A pause still open on the row is not working time, to the run's end or to now -- the sweep's
    // own rule. A resume claim folds the span into `pausedMs` and clears `pausedAt`, so nothing is
    // subtracted twice; a stop (`requestStop`) ends a paused run and leaves `pausedAt` set.
    const openPause = run.pausedAt === null ? 0 : Math.max(0, end.getTime() - run.pausedAt.getTime())
    return total + Math.max(0, end.getTime() - run.startedAt.getTime() - run.pausedMs - openPause)
  }, 0)
}
