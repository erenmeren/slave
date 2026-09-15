import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { toRunState } from '@slave-of-ai/db'
import {
  deriveSlaveStatus,
  effectiveSkills,
  NON_TERMINAL_RUN_STATUSES,
  type SkillOrigin,
  type SlaveStatus,
} from '@slave-of-ai/domain'

export interface SkillRow {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Summed `SlaveRun.skillCalls[name]` across every run. `0` is a measured zero here: the tally
   *  exists on every concluded run, so a skill with no calls really has none. */
  readonly runs: number
  /** `'missing'` when `missingSince` is set — the skill is gone from disk but its history is not
   *  (Decision 6). */
  readonly state: 'ready' | 'missing'
  /** M58 R3: WHO has this skill, and how. The effective set is `TemplateSkill ∪ granted − revoked`
   *  computed on read, so a persona's default reaches every person hired from it without a row --
   *  and `origin` is what lets the page say which of the two a holder is. */
  readonly holders: readonly { readonly personId: string; readonly origin: SkillOrigin }[]
}

export interface SkillProviderRow {
  readonly id: string
  readonly name: string
  readonly skills: readonly SkillRow[]
}

export interface SkillsPage {
  readonly providers: readonly SkillProviderRow[]
  /**
   * Every PERSON, for the row's assign control (M58 R3: a skill belongs to somebody, not to a
   * seat). `id` is a `Person.id`. `status` is the domain's own `SlaveStatus` rather than a bare
   * `string` so the client can tone the assignment chips through `lib/tones.ts`'s exhaustive
   * `cardStateForSlave` — a widened `string` there would need a default branch, which is exactly
   * the silent fall-through that file exists to rule out.
   */
  readonly slaves: readonly { readonly id: string; readonly name: string; readonly status: SlaveStatus }[]
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
      SELECT "skillCalls" FROM "SlaveRun"
      WHERE "skillCalls" IS NOT NULL AND jsonb_typeof("skillCalls") = 'object'
    ) runs, LATERAL jsonb_each(runs."skillCalls") AS je
    WHERE jsonb_typeof(je.value) = 'number'
    GROUP BY je.key`
  return new Map(rows.map((row) => [row.name, row.total]))
}

/**
 * The Skills page's snapshot (M14 §5.8). Run counts are summed from `SlaveRun.skillCalls`, which
 * is an END-OF-RUN fact (§4.1): a run in flight contributes nothing, so a skill invoked by a live
 * run shows its previous total until that run concludes. Stated here because a page of counts
 * that silently trails the board is worse than one that says it does.
 */
export async function buildSkillsPage(): Promise<SkillsPage> {
  const [providers, totals, personSkills, templateSkills, persons, liveRuns] = await Promise.all([
    // Alphabetical, which is also the spec's stated order — `personal` < `plugin:*` < `project`
    // sort that way on their own, so this needs no hand-written provider ranking to maintain.
    prisma.skillProvider.findMany({ orderBy: { name: 'asc' }, include: { skills: { orderBy: { name: 'asc' } } } }),
    skillCallTotals(),
    // M58 R3: the two join tables, whole. Both are small -- one row per (person, skill) somebody
    // adjusted and one per (persona, skill) somebody made a default -- and `effectiveSkills` is
    // handed both per person rather than a query per person.
    prisma.personSkill.findMany({ orderBy: [{ personId: 'asc' }, { skillId: 'asc' }] }),
    prisma.templateSkill.findMany({ orderBy: [{ templateId: 'asc' }, { skillId: 'asc' }] }),
    prisma.person.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, templateId: true } }),
    // No `select`: `toRunState` maps a whole `SlaveRun` row, and narrowing the query to the four
    // columns it reads today would hand it an object the mapper's own type rejects (the same
    // reason `server/shell.ts:40` gives). The row set is bounded by the live runs, not by history.
    prisma.slaveRun.findMany({ where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } }, include: { slave: { select: { personId: true } } } }),
  ])

  const templateSkillIdsByTemplate = new Map<string, string[]>()
  for (const row of templateSkills) {
    const list = templateSkillIdsByTemplate.get(row.templateId)
    if (list === undefined) templateSkillIdsByTemplate.set(row.templateId, [row.skillId])
    else list.push(row.skillId)
  }
  const holdersBySkill = new Map<string, { readonly personId: string; readonly origin: SkillOrigin }[]>()
  for (const person of persons) {
    const own = personSkills.filter((row) => row.personId === person.id)
    for (const skill of effectiveSkills({
      templateSkillIds: person.templateId === null ? [] : (templateSkillIdsByTemplate.get(person.templateId) ?? []),
      granted: own.filter((row) => row.mode === 'granted').map((row) => row.skillId),
      revoked: own.filter((row) => row.mode === 'revoked').map((row) => row.skillId),
    })) {
      const list = holdersBySkill.get(skill.skillId)
      const holder = { personId: person.id, origin: skill.origin }
      if (list === undefined) holdersBySkill.set(skill.skillId, [holder])
      else list.push(holder)
    }
  }

  // A person is "working" when any of their OPEN seats holds a live run: the status the chips tone
  // is the person's, because the chip names the person (M58 R3).
  const statusBySlave = new Map(liveRuns.map((run) => [run.slave.personId, deriveSlaveStatus(toRunState(run))] as const))

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
          holders: holdersBySkill.get(skill.id) ?? [],
        }
      }),
    })),
    slaves: persons.map((person) => ({ id: person.id, name: person.name, status: statusBySlave.get(person.id) ?? 'idle' })),
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
