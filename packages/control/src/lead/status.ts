import { prisma } from '@slave-of-ai/db/client'
import { SUBORDINATE_TOOLS, buildRosterDefinitions, err, ok, readLeadProgress, type LeadProgress, type LeadState, type Result } from '@slave-of-ai/domain'
import { gitIn } from '../git.js'
import type { ControlRefusal } from '../refusal.js'
import { loadLeadRoster } from './roster.js'
import { goalSpend, goalWorkedMs, type GoalSpend } from './spend.js'

/** Lead-flow spec B10: what a lead-flow goal version is doing, as the CLI prints it. */
export interface LeadStatusView {
  readonly goalVersion: number
  readonly state: LeadState | null
  readonly stopReason: string | null
  readonly status: string
  readonly round: number
  readonly workBranch: string
  /** The work branch's newest commits, `<sha> <subject>`; empty when the branch cannot be read. */
  readonly lastCommits: readonly string[]
  readonly progress: LeadProgress
  readonly budgetUsd: number | null
  readonly spend: GoalSpend
  readonly timeLimitMs: number | null
  readonly workedMs: number
  readonly turns: readonly { readonly runId: string; readonly turn: string; readonly status: string; readonly resumed: boolean; readonly costUsd: number | null; readonly startedAt: string; readonly endedAt: string | null }[]
  /** Subordinate calls of the lead's turns by session definition; `personId` is the roster person behind it, null for a general one. */
  readonly subordinates: readonly { readonly name: string; readonly personId: string | null; readonly calls: number; readonly running: number }[]
  readonly notes: readonly { readonly at: string; readonly kind: string; readonly detail: string }[]
}

/**
 * Lead-flow spec B10 (plan A): the live state of one lead-flow goal version (the newest when none
 * is named) -- its state word, what it spent and took, its turns, which subordinates worked and
 * which still do (a subordinate call with no result on a live turn), the last commits and the
 * report lines. A read: nothing here writes.
 */
export async function leadStatus(workspaceId: string, goalVersion?: number): Promise<Result<LeadStatusView, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { repoPath: true, budgetUsd: true, goalTimeLimitMs: true, leadRoster: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const delivery = await prisma.goalDelivery.findFirst({
    where: { workspaceId, leadState: { not: null }, ...(goalVersion === undefined ? {} : { goalVersion }) },
    orderBy: { goalVersion: 'desc' },
  })
  if (delivery === null) return goalVersion === undefined ? err({ kind: 'not_lead_flow', workspaceId }) : err({ kind: 'goal_version_not_found', workspaceId, goalVersion })

  const turns = await prisma.slaveRun.findMany({
    where: { leadTurn: { not: null }, task: { workspaceId, workPackage: { goalVersion: delivery.goalVersion } } },
    orderBy: { startedAt: 'asc' },
    select: { id: true, leadTurn: true, status: true, leadResumed: true, costUsd: true, startedAt: true, endedAt: true },
  })
  const liveIds = new Set(turns.filter((turn) => turn.endedAt === null).map((turn) => turn.id))
  const events = await prisma.executionEvent.findMany({
    where: { runId: { in: turns.map((turn) => turn.id) }, type: { in: ['run_tool_call', 'run_tool_result'] } },
    orderBy: { seq: 'asc' },
    select: { type: true, runId: true, payload: true },
  })
  const finished = new Set(events.filter((event) => event.type === 'run_tool_result').map((event) => (event.payload as { readonly toolUseId?: string }).toolUseId))
  const slugs = buildRosterDefinitions(await loadLeadRoster(workspace.leadRoster)).slugs
  const byName = new Map<string, { calls: number; running: number }>()
  for (const event of events) {
    if (event.type !== 'run_tool_call') continue
    const payload = event.payload as { readonly name?: string; readonly subagent?: string; readonly toolUseId?: string; readonly parentToolUseId?: string }
    // C1: top-level calls only -- a subordinate starting a session of its own is its own business.
    if (payload.name === undefined || !SUBORDINATE_TOOLS.includes(payload.name) || payload.parentToolUseId !== undefined) continue
    const name = payload.subagent ?? 'general-purpose'
    const entry = byName.get(name) ?? { calls: 0, running: 0 }
    entry.calls += 1
    if (event.runId !== null && liveIds.has(event.runId) && !finished.has(payload.toolUseId)) entry.running += 1
    byName.set(name, entry)
  }
  const notes = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'workspace_lead_noted', payload: { path: ['version'], equals: delivery.goalVersion } },
    orderBy: { seq: 'desc' },
    take: 30,
    select: { ts: true, payload: true },
  })
  const lastCommits = await gitIn(workspace.repoPath, 'log', '--oneline', '-10', `refs/heads/${delivery.integrationBranch}`).then(
    (out) => out.split('\n').filter((line) => line !== ''),
    () => [],
  )

  return ok({
    goalVersion: delivery.goalVersion,
    state: delivery.leadState,
    stopReason: delivery.stopReason,
    status: delivery.status,
    round: delivery.round,
    workBranch: delivery.integrationBranch,
    lastCommits,
    progress: readLeadProgress(delivery.leadProgress),
    budgetUsd: workspace.budgetUsd,
    spend: await goalSpend(workspaceId, delivery.goalVersion),
    timeLimitMs: workspace.goalTimeLimitMs,
    workedMs: await goalWorkedMs(workspaceId, delivery.goalVersion),
    turns: turns.map((turn) => ({
      runId: turn.id,
      turn: turn.leadTurn ?? '',
      status: turn.status,
      resumed: turn.leadResumed,
      costUsd: turn.costUsd,
      startedAt: turn.startedAt.toISOString(),
      endedAt: turn.endedAt?.toISOString() ?? null,
    })),
    subordinates: [...byName].map(([name, entry]) => ({ name, personId: slugs.get(name) ?? null, calls: entry.calls, running: entry.running })).sort((a, b) => a.name.localeCompare(b.name)),
    notes: notes.reverse().map((row) => ({ at: row.ts.toISOString(), kind: (row.payload as { kind: string }).kind, detail: (row.payload as { detail: string }).detail })),
  })
}
