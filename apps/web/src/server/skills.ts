import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { toRunState } from '@slave-of-ai/db'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES, type AgentStatus } from '@slave-of-ai/domain'

export interface SkillRow {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Summed `AgentRun.skillCalls[name]` across every run. `0` is a measured zero here: the tally
   *  exists on every concluded run, so a skill with no calls really has none. */
  readonly runs: number
  /** `'missing'` when `missingSince` is set — the skill is gone from disk but its history is not
   *  (Decision 6). */
  readonly state: 'ready' | 'missing'
  readonly agentIds: readonly string[]
}

export interface SkillProviderRow {
  readonly id: string
  readonly name: string
  readonly skills: readonly SkillRow[]
}

export interface SkillsPage {
  readonly providers: readonly SkillProviderRow[]
  /**
   * Every agent, for the row's assign control. `status` is the domain's own `AgentStatus` rather
   * than a bare `string` so the client can tone the assignment chips through `lib/tones.ts`'s
   * exhaustive `cardStateForAgent` — a widened `string` there would need a default branch, which
   * is exactly the silent fall-through that file exists to rule out.
   */
  readonly agents: readonly { readonly id: string; readonly name: string; readonly status: AgentStatus }[]
  /** The three directories `syncSkillCatalog` scans, for the "add skill source" tile. Shown, not
   *  editable — there is no write path, and a tile that looked editable would be one. */
  readonly scannedRoots: readonly string[]
}

const PLUGIN_PREFIX = 'plugin:'

/**
 * The tally key a call to this skill would have been recorded under.
 *
 * A `Skill` tool_use carries `{"skill": "<plugin>:<name>"}` for a plugin skill and the bare
 * `<name>` otherwise — measured, `packages/providers/src/runtime/summary.ts:12` and the
 * `skill-tool-use.ndjson` fixture behind it. The catalog's provider name for the same skill is
 * `plugin:<plugin>`, so the two are one `slice` apart.
 */
function tallyKeyFor(providerName: string, skillName: string): string {
  return providerName.startsWith(PLUGIN_PREFIX) ? `${providerName.slice(PLUGIN_PREFIX.length)}:${skillName}` : skillName
}

/**
 * Per-skill call totals summed in SQL — the `skillCalls` JSON never crosses the wire whole.
 * Guards mirror the old in-memory loop exactly: a non-object column (Cursor's DbNull is SQL
 * NULL; a JsonNull would be 'null'::jsonb) contributes nothing, and a non-number value inside
 * an object is skipped. jsonb numbers are always finite, so `Number.isFinite` has no SQL twin.
 * Proven against that old loop by `test/integration/skill-call-totals.test.ts`, which stays in
 * the suite as the permanent equivalence oracle.
 */
export async function skillCallTotals(): Promise<ReadonlyMap<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ name: string; total: number }>>`
    SELECT je.key AS name, SUM((je.value)::numeric)::float8 AS total
    FROM (
      SELECT "skillCalls" FROM "AgentRun"
      WHERE "skillCalls" IS NOT NULL AND jsonb_typeof("skillCalls") = 'object'
    ) runs, LATERAL jsonb_each(runs."skillCalls") AS je
    WHERE jsonb_typeof(je.value) = 'number'
    GROUP BY je.key`
  return new Map(rows.map((row) => [row.name, row.total]))
}

/**
 * The Skills page's snapshot (M14 §5.8). Run counts are summed from `AgentRun.skillCalls`, which
 * is an END-OF-RUN fact (§4.1): a run in flight contributes nothing, so a skill invoked by a live
 * run shows its previous total until that run concludes. Stated here because a page of counts
 * that silently trails the board is worse than one that says it does.
 */
export async function buildSkillsPage(): Promise<SkillsPage> {
  const [providers, totals, assignments, agents, liveRuns] = await Promise.all([
    // Alphabetical, which is also the spec's stated order — `personal` < `plugin:*` < `project`
    // sort that way on their own, so this needs no hand-written provider ranking to maintain.
    prisma.skillProvider.findMany({ orderBy: { name: 'asc' }, include: { skills: { orderBy: { name: 'asc' } } } }),
    skillCallTotals(),
    prisma.agentSkill.findMany({ orderBy: { agentId: 'asc' } }),
    prisma.agent.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    // No `select`: `toRunState` maps a whole `AgentRun` row, and narrowing the query to the four
    // columns it reads today would hand it an object the mapper's own type rejects (the same
    // reason `server/shell.ts:40` gives). The row set is bounded by the live runs, not by history.
    prisma.agentRun.findMany({ where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } } }),
  ])

  const agentsBySkill = new Map<string, string[]>()
  for (const row of assignments) {
    const list = agentsBySkill.get(row.skillId)
    if (list === undefined) agentsBySkill.set(row.skillId, [row.agentId])
    else list.push(row.agentId)
  }

  const statusByAgent = new Map(liveRuns.map((run) => [run.agentId, deriveAgentStatus(toRunState(run))] as const))

  return {
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      skills: provider.skills.map((skill) => {
        const key = tallyKeyFor(provider.name, skill.name)
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          // ONE index, keyed by exactly what the pump wrote. There is deliberately no looser
          // second lookup: an earlier round kept a trailing-segment fallback for a `plugin:*`
          // row whose qualified key was never recorded, and it made a never-invoked
          // `plugin:code-review` display the personal `code-review`'s nine calls -- a
          // fabricated number on a row, which is worse than the merged totals it was meant to
          // prevent. A skill nobody invoked reads `0`, and that zero is a measurement
          // (Decision 3). Nothing is lost by the strictness: `tallyKeyFor` already returns the
          // bare name for a `personal`/`project` provider, so those tallies are found by exact
          // key.
          runs: totals.get(key) ?? 0,
          state: skill.missingSince === null ? ('ready' as const) : ('missing' as const),
          agentIds: agentsBySkill.get(skill.id) ?? [],
        }
      }),
    })),
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, status: statusByAgent.get(agent.id) ?? 'idle' })),
    // The same three roots `syncSkillCatalog` scans (`packages/control/src/skills.ts:48-54`),
    // named so the "add skill source" tile can SHOW them. Read-only, deliberately: there is no
    // write path for a fourth root, and a tile that accepted input would be one that silently
    // discarded it (Decision 7).
    scannedRoots: [
      join(homedir(), '.claude', 'skills'),
      join(homedir(), '.claude', 'plugins', 'cache'),
      join(process.cwd(), '.claude', 'skills'),
    ],
  }
}
