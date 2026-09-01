import { prisma } from '@ai-team-os/db/client'
import { NON_TERMINAL_RUN_STATUSES, type RunStatus } from '@ai-team-os/domain'
import { skillNameOf, UNKNOWN_SKILL_NAME } from '../lib/skillName'

/** Series B (M18): how many of the workspace's most recently active Skill-calling runs feed the
 *  chain view. "Most recently active" is defined by the MAX `seq` among a run's own Skill events
 *  (a run whose latest Skill call is the most recent one, workspace-wide), not `AgentRun.startedAt`
 *  -- chosen because it is the same table and the same query that finds the candidate runIds in
 *  the first place (`executionEvent.groupBy`), so the bound applies in ONE query rather than an
 *  unbounded id list handed to a second, separately-sorted one. */
export const SKILL_GRAPH_RUN_LIMIT = 50

export interface SkillGraphRun {
  readonly runId: string
  readonly taskTitle: string | null
  readonly agentName: string
  readonly live: boolean
  readonly startedAt: string
  readonly chain: readonly { readonly name: string; readonly count: number }[]
}

export interface SkillGraph {
  readonly skills: readonly { readonly name: string; readonly calls: number }[]
  /** Rendered as cable thickness since M19 (C3). */
  readonly edges: readonly { readonly from: string; readonly to: string; readonly count: number }[]
  readonly runs: readonly SkillGraphRun[]
}

interface SkillEventRow {
  readonly runId: string | null
  readonly seq: bigint
  readonly payload: unknown
}

/** Consecutive repeats of the same name collapse into one `{name, count}` entry -- a run that
 *  called the same skill three times in a row is one link in the chain, not three. */
function collapseChain(names: readonly string[]): readonly { name: string; count: number }[] {
  const chain: { name: string; count: number }[] = []
  for (const name of names) {
    const last = chain[chain.length - 1]
    if (last !== undefined && last.name === name) last.count += 1
    else chain.push({ name, count: 1 })
  }
  return chain
}

export async function buildSkillGraph(workspaceId: string): Promise<SkillGraph | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  // Step 1 (bound BEFORE the event fetch, M17 §4): the newest `SKILL_GRAPH_RUN_LIMIT` distinct
  // runIds that have a Skill event at all, in ONE grouped query -- "newest" is each run's own
  // latest Skill event (`_max: seq`), ordered desc, so the LIMIT is applied by the database, not
  // by fetching every candidate and sorting/truncating in JS. The row it reads per match is bare
  // (`runId`, `seq`), not the full payload the chain itself needs.
  //
  // This query and the `findMany` below (M19 C1 migration
  // `20260901120000_m19_skill_calls_partial_index`) ride
  // `ExecutionEvent_skill_calls_idx` -- `(workspaceId, type, runId, seq)`, partial on
  // `(payload #> '{name}') = '"Skill"'::jsonb`. The `findMany`'s `ORDER BY runId, seq` is fully
  // satisfied by index order (no `Sort` node). This groupBy still needs its own outer sort by
  // `MAX(seq) DESC` -- that orders an *aggregate result*, which no index order can ever satisfy
  // -- but the index removes the *input* sort that used to feed `GroupAggregate` (grouping by
  // `runId` is now free, since index order already delivers rows in `runId` order).
  //
  // The index is reachable only because Prisma's `@prisma/adapter-pg` issues these as UNNAMED
  // prepared statements, which Postgres always plans as CUSTOM plans -- substituting the actual
  // bound `workspaceId`/`type`/`payload` values before the partial predicate is checked. A
  // GENERIC plan (a named/cached prepared statement, which a driver change could start using)
  // cannot prove the predicate from unbound parameters, and the index would go dead silently --
  // EXPLAIN would keep showing a correct result with no error, just a Seq Scan again.
  const grouped = await prisma.executionEvent.groupBy({
    by: ['runId'],
    where: { workspaceId, type: 'run_tool_call', runId: { not: null }, payload: { path: ['name'], equals: 'Skill' } },
    _max: { seq: true },
    orderBy: { _max: { seq: 'desc' } },
    take: SKILL_GRAPH_RUN_LIMIT,
  })
  const runIds = grouped.map((row) => row.runId).filter((id): id is string => id !== null)
  if (runIds.length === 0) return { skills: [], edges: [], runs: [] }

  // Run metadata (task title, agent name, live status, startedAt) for exactly those runs, one
  // query. Ordered newest-`startedAt`-first for the `runs` list a reader sees -- distinct from,
  // but not in conflict with, the `_max seq` order that bounded the SET of runs above.
  const runRows = await prisma.agentRun.findMany({
    where: { id: { in: runIds } },
    orderBy: { startedAt: 'desc' },
    include: { task: true, agent: true },
  })

  // Step 2: the ordered event fetch, bounded to exactly those runs -- rides the `(runId, seq)`
  // index (Task 1's migration) rather than scanning the workspace's full event history.
  const eventRows: readonly SkillEventRow[] = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'run_tool_call', runId: { in: runIds }, payload: { path: ['name'], equals: 'Skill' } },
    orderBy: [{ runId: 'asc' }, { seq: 'asc' }],
    select: { runId: true, seq: true, payload: true },
  })

  // The rows arrive grouped by `runId` (then in `seq` order within each group), so a single pass
  // both partitions by run AND preserves each run's call order -- no second sort needed.
  const namesByRun = new Map<string, string[]>()
  for (const row of eventRows) {
    if (row.runId === null) continue
    const name = skillNameOf((row.payload as { summary?: unknown }).summary) ?? UNKNOWN_SKILL_NAME
    const names = namesByRun.get(row.runId)
    if (names === undefined) namesByRun.set(row.runId, [name])
    else names.push(name)
  }

  const chainByRun = new Map<string, readonly { readonly name: string; readonly count: number }[]>()
  for (const [runId, names] of namesByRun) chainByRun.set(runId, collapseChain(names))

  // Aggregate `skills`: total calls per name across every run's collapsed chain. Summing the
  // COLLAPSED counts equals summing the raw per-call names -- collapsing only merges adjacent
  // duplicates into one entry whose count already carries their total, it never drops a call.
  const callsByName = new Map<string, number>()
  // `edges`: adjacent DISTINCT pairs (post-collapse, so `from !== to` is already guaranteed --
  // collapsing removed every adjacent same-name repeat) across all runs, directed and summed.
  const edgeCounts = new Map<string, { readonly from: string; readonly to: string; count: number }>()
  for (const chain of chainByRun.values()) {
    for (const link of chain) callsByName.set(link.name, (callsByName.get(link.name) ?? 0) + link.count)
    for (let i = 0; i < chain.length - 1; i += 1) {
      const from = chain[i]?.name
      const to = chain[i + 1]?.name
      if (from === undefined || to === undefined) continue
      const key = `${from} ${to}`
      const existing = edgeCounts.get(key)
      if (existing === undefined) edgeCounts.set(key, { from, to, count: 1 })
      else existing.count += 1
    }
  }

  const skills = [...callsByName.entries()]
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const edges = [...edgeCounts.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )

  const runs: SkillGraphRun[] = runRows.map((run) => ({
    runId: run.id,
    taskTitle: run.task?.title ?? null,
    agentName: run.agent.name,
    live: (NON_TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(run.status),
    startedAt: run.startedAt.toISOString(),
    chain: chainByRun.get(run.id) ?? [],
  }))

  return { skills, edges, runs }
}
