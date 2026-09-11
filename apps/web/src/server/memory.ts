import { listCapabilities, listMemories, readMemory } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  MEMORY_CONFIDENCE_LABEL,
  MEMORY_SCOPE_LABEL,
  MEMORY_STATUSES,
  MEMORY_STATUS_LABEL,
  MEMORY_TYPE_LABEL,
  capabilityIndex,
  provenanceLine,
  runContextManifestSchema,
  type CapabilityRecord,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type MemoryView,
} from '@slave-of-ai/domain'

/**
 * One row of the Knowledge tab (M49 R6).
 *
 * The memory AND the words for it: every enum member this page shows is projected here, once, so
 * the component cannot reach for a key (`docs/ia.md` rule 3) and the CLI, the prompt and the page
 * all print the same provenance sentence -- `provenanceLine` is the domain's.
 */
export interface KnowledgeRow {
  readonly memory: MemoryView
  readonly typeLabel: string
  readonly scopeLabel: string
  readonly statusLabel: string
  readonly confidenceLabel: string
  /** The retrieval references as WORDS, with the key beside each for `title` -- `server/
   *  organization.ts`'s own `{ key, label }` pair, so one capability reads the same on both tabs. */
  readonly capabilities: readonly { readonly key: string; readonly label: string }[]
  readonly provenance: string
  readonly taskTitle: string | null
  /**
   * What this row replaced, for the expanded chain -- a LIST, oldest first.
   *
   * `MemoryChain.supersedes` is a list (Task 2 fix round 1): a verified fact retires EVERY open
   * candidate its task left behind in one transaction (D3), so "what did this replace" has more
   * than one answer whenever a task reported twice. Empty for a memory that replaced nothing.
   */
  readonly supersedesIds: readonly string[]
}

export interface KnowledgeView {
  readonly workspaceId: string
  readonly rows: readonly KnowledgeRow[]
  /**
   * The TITLE of every memory a row's chain points at -- what it replaced, what replaced it, what
   * it summarises -- keyed by id.
   *
   * On the VIEW rather than on each row because the same memory is pointed at from both ends of a
   * correction, and because a row's own chain is three lists of ids: one map read once beats three
   * decorated sub-lists per row. An id this map has no entry for is still printed -- the id is
   * findable, a made-up title is not.
   */
  readonly memoryTitles: Readonly<Record<string, string>>
  /**
   * The two numbers the Overview's brief line prints (R6, plan erratum E6).
   *
   * Counted over the whole project, never over the filtered rows -- a filter must not change what
   * the brief says. And over this project's OWN memories, not over the wider set `listMemories`
   * returns (which also carries the company's knowledge and this project's workers'): the same two
   * counts are computed in `server/brief.ts`, and one number said two ways on two surfaces is how a
   * reader learns to trust neither.
   */
  readonly counts: { readonly verified: number; readonly candidates: number }
}

export interface KnowledgeFilters {
  readonly scope?: MemoryScope
  readonly type?: MemoryType
  readonly statuses?: readonly MemoryStatus[]
  readonly q?: string
}

/** R6/plan decision D11: verified knowledge and the claims waiting on a person. Superseded and
 *  removed rows are one filter away and never hidden -- "nothing is ever deleted" has to be
 *  checkable from the product. */
export const DEFAULT_KNOWLEDGE_STATUSES: readonly MemoryStatus[] = ['verified', 'candidate']

export async function buildKnowledge(
  workspaceId: string,
  filters: KnowledgeFilters = {},
): Promise<KnowledgeView | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  // The one null this builder has, decided HERE: `listMemories` answers `[]` for a workspace that
  // is not there, and a page owes its caller a 404 rather than an empty list (`buildRunbookPanel`'s
  // own rule).
  if (workspace === null) return null

  // Everything this project can READ -- its own rows, its company's, and its workers' (
  // `listMemories`' own three scopes). The Knowledge tab is what this project knows, not only what
  // it wrote, and the `scope` filter is how a person narrows to one of the three.
  const rows = await listMemories({
    workspaceId,
    ...(filters.scope === undefined ? {} : { scope: filters.scope }),
    ...(filters.type === undefined ? {} : { type: filters.type }),
    // `listMemories` returns EVERY status when it is not told otherwise (Task 2's own rule), so
    // this page always says which ones it wants.
    statuses: filters.statuses ?? DEFAULT_KNOWLEDGE_STATUSES,
    ...(filters.q === undefined ? {} : { q: filters.q }),
  })
  const [decorated, verified, candidates] = await Promise.all([
    decorate(rows),
    prisma.memory.count({ where: { workspaceId, status: 'verified' } }),
    prisma.memory.count({ where: { workspaceId, status: 'candidate' } }),
  ])
  return {
    workspaceId,
    rows: decorated.rows,
    memoryTitles: decorated.titles,
    counts: { verified, candidates },
  }
}

/**
 * The words, the task titles and the chain pointers for a whole page of memories -- in four reads
 * for the page rather than four per row.
 *
 * The taxonomy is read here and indexed ONCE (the M47 carry): `capabilityLabel` builds a fresh Map
 * per call, and a page of twenty memories carrying twenty capability keys between them would build
 * it twenty times.
 */
async function decorate(
  memories: readonly MemoryView[],
): Promise<{ readonly rows: readonly KnowledgeRow[]; readonly titles: Readonly<Record<string, string>> }> {
  if (memories.length === 0) return { rows: [], titles: {} }

  const taskIds = [
    ...new Set(memories.flatMap((one) => (one.provenance.taskId === null ? [] : [one.provenance.taskId]))),
  ]
  const ids = memories.map((one) => one.id)
  // The other end of every chain link a row can draw: what replaced it, and what it summarises.
  const linkIds = [
    ...new Set(
      memories.flatMap((one) => [
        ...(one.supersededById === null ? [] : [one.supersededById]),
        ...one.sourceIds,
      ]),
    ),
  ]
  const [tasks, replaced, links, taxonomy] = await Promise.all([
    taskIds.length === 0
      ? Promise.resolve([])
      : prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } }),
    // Ordered the way `readMemory`'s own `supersedes` list is (Task 2 fix round 1), so the CLI's
    // `replaced:` lines and this page's chain read in the same order.
    prisma.memory.findMany({
      where: { supersededById: { in: ids } },
      select: { id: true, title: true, supersededById: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    linkIds.length === 0
      ? Promise.resolve([])
      : prisma.memory.findMany({ where: { id: { in: linkIds } }, select: { id: true, title: true } }),
    listCapabilities(),
  ])

  const titleById = new Map(tasks.map((task) => [task.id, task.title]))
  const replacedByMemory = new Map<string, string[]>()
  for (const row of replaced) {
    if (row.supersededById === null) continue
    const already = replacedByMemory.get(row.supersededById)
    if (already === undefined) replacedByMemory.set(row.supersededById, [row.id])
    else already.push(row.id)
  }
  const titles: Record<string, string> = {}
  for (const row of [...replaced, ...links]) titles[row.id] = row.title
  const label = labeller(taxonomy)

  const rows = memories.map((memory) => {
    const taskTitle = memory.provenance.taskId === null ? null : (titleById.get(memory.provenance.taskId) ?? null)
    return {
      memory,
      typeLabel: MEMORY_TYPE_LABEL[memory.type],
      scopeLabel: MEMORY_SCOPE_LABEL[memory.scope],
      statusLabel: MEMORY_STATUS_LABEL[memory.status],
      confidenceLabel: MEMORY_CONFIDENCE_LABEL[memory.confidence],
      capabilities: memory.capabilities.map((key) => ({ key, label: label(key) })),
      provenance: provenanceLine(memory, taskTitle),
      taskTitle,
      supersedesIds: replacedByMemory.get(memory.id) ?? [],
    }
  })
  return { rows, titles }
}

/** `capabilityLabel`'s answer over ONE index, with the key itself as the fallback -- `server/
 *  organization.ts`'s own helper, for its own reason: a memory written by a newer build can name a
 *  key this bundle's taxonomy has never heard of. */
function labeller(taxonomy: readonly CapabilityRecord[]): (key: string) => string {
  const index = capabilityIndex(taxonomy)
  return (key) => index.get(key)?.label ?? key
}

export interface TaskMemoriesView {
  /** What this task's runs were GIVEN, read off their recorded manifests (plan erratum E7). */
  readonly received: readonly KnowledgeRow[]
  /** What this task PRODUCED -- every memory carrying its id. */
  readonly produced: readonly KnowledgeRow[]
}

/**
 * The task drawer's `memories` group (M49 R6).
 *
 * "Received" cannot come from a `Memory` column: it is the `memory` entries on this task's runs'
 * `RunContext` manifests, which is the only record of what a run was actually told (plan erratum
 * E7). A manifest that will not parse is SKIPPED rather than fatal -- the same tolerance
 * `show-context`'s reader is built on, one level softer because this is a panel.
 */
export async function buildTaskMemories(workspaceId: string, taskId: string): Promise<TaskMemoriesView | null> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, workspaceId: true } })
  if (task === null || task.workspaceId !== workspaceId) return null

  const contexts = await prisma.runContext.findMany({
    where: { run: { taskId } },
    select: { sections: true },
    orderBy: { createdAt: 'asc' },
  })
  const receivedIds: string[] = []
  for (const context of contexts) {
    const parsed = runContextManifestSchema.safeParse(context.sections)
    if (!parsed.success) continue
    for (const source of parsed.data.sections) {
      if (source.kind === 'memory') receivedIds.push(...source.memoryIds)
    }
  }

  const unique = [...new Set(receivedIds)]
  const [receivedRows, producedRows] = await Promise.all([
    unique.length === 0 ? Promise.resolve<readonly MemoryView[]>([]) : loadByIds(unique),
    // Every status: this group is a record of what happened to this task's knowledge, and hiding
    // the superseded candidate would hide the whole point of R2(b).
    listMemories({ workspaceId, taskId, statuses: MEMORY_STATUSES }),
  ])

  // ONE decoration over both lists (a memory can be in both -- a task is routinely given what an
  // earlier run of it produced), so the taxonomy, the task titles and the chain pointers are read
  // once for the panel rather than once per list.
  const byId = new Map<string, MemoryView>()
  for (const one of [...receivedRows, ...producedRows]) byId.set(one.id, one)
  const decorated = await decorate([...byId.values()])
  const rowById = new Map(decorated.rows.map((row) => [row.memory.id, row]))
  const pick = (source: readonly MemoryView[]): readonly KnowledgeRow[] =>
    source.flatMap((one) => {
      const row = rowById.get(one.id)
      return row === undefined ? [] : [row]
    })
  return { received: pick(receivedRows), produced: pick(producedRows) }
}

/** The given memories themselves, by id -- through `readMemory` so a row and its chain are read by
 *  the one verb that knows how, and in id order so the group is stable between renders. */
async function loadByIds(ids: readonly string[]): Promise<readonly MemoryView[]> {
  const found = await Promise.all([...ids].sort().map(async (id) => readMemory(id)))
  return found.flatMap((one) => (one.ok ? [one.value.memory] : []))
}
