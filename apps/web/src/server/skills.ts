import { homedir } from 'node:os'
import { join } from 'node:path'
import { Prisma, prisma } from '@ai-team-os/db/client'
import { toRunState } from '@ai-team-os/db'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES, type AgentStatus } from '@ai-team-os/domain'

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
 * The Skills page's snapshot (M14 §5.8). Run counts are summed from `AgentRun.skillCalls`, which
 * is an END-OF-RUN fact (§4.1): a run in flight contributes nothing, so a skill invoked by a live
 * run shows its previous total until that run concludes. Stated here because a page of counts
 * that silently trails the board is worse than one that says it does.
 */
export async function buildSkillsPage(): Promise<SkillsPage> {
  const [providers, runs, assignments, agents, liveRuns] = await Promise.all([
    // Alphabetical, which is also the spec's stated order — `personal` < `plugin:*` < `project`
    // sort that way on their own, so this needs no hand-written provider ranking to maintain.
    prisma.skillProvider.findMany({ orderBy: { name: 'asc' }, include: { skills: { orderBy: { name: 'asc' } } } }),
    // `Prisma.DbNull`, not a bare `null`: `skillCalls` is a nullable Json column, where Prisma
    // rejects `null` as ambiguous between a JSON `null` and an absent value (`db/client.ts`).
    // The filter matters beyond tidiness — a Cursor run is `null` here, and Decision 4 says an
    // unmeasured run must contribute nothing rather than a zero.
    prisma.agentRun.findMany({ where: { skillCalls: { not: Prisma.DbNull } }, select: { skillCalls: true } }),
    prisma.agentSkill.findMany({ orderBy: { agentId: 'asc' } }),
    prisma.agent.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    // No `select`: `toRunState` maps a whole `AgentRun` row, and narrowing the query to the four
    // columns it reads today would hand it an object the mapper's own type rejects (the same
    // reason `server/shell.ts:40` gives). The row set is bounded by the live runs, not by history.
    prisma.agentRun.findMany({ where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } } }),
  ])

  // Two indexes over the same tallies, because a tally key and a `Skill` row do not always agree:
  //   - `exact` is what the pump actually wrote (`superpowers:writing-plans`).
  //   - `bare` is that key's trailing segment, the form a personal/project skill is called under.
  // A skill is looked up by its OWN provider-qualified key first, so two providers carrying the
  // same skill name (`code-review` exists both as a plugin skill and as a personal one) never
  // share a count. The bare fallback only fires when the qualified key was never recorded — it
  // keeps a pre-prefix tally visible at the cost of being ambiguous in exactly that case, which
  // is a better trade than showing a `0` for a skill the agents demonstrably used.
  const exact = new Map<string, number>()
  const bare = new Map<string, number>()
  for (const run of runs) {
    for (const [name, count] of Object.entries((run.skillCalls as Record<string, unknown> | null) ?? {})) {
      // `typeof count === 'number'` because the column is Json and nothing in the database
      // enforces its shape: a malformed tally must be skipped, never coerced into a total.
      if (typeof count !== 'number' || !Number.isFinite(count)) continue
      exact.set(name, (exact.get(name) ?? 0) + count)
      const trailing = name.includes(':') ? (name.split(':').at(-1) ?? name) : name
      bare.set(trailing, (bare.get(trailing) ?? 0) + count)
    }
  }

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
          runs: exact.get(key) ?? bare.get(skill.name) ?? 0,
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
