import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  MEMORIES_IN_PROMPT,
  MEMORIES_LOADED_MAX,
  MEMORY_BODY_MAX,
  MEMORY_CANDIDATE_STALE_MS,
  MEMORY_TITLE_MAX,
  MEMORY_TYPES,
  capCodePoints,
  condenseMemories,
  err,
  ok,
  parseMemoryDraft,
  retrieveMemories,
  type MemoryConfidence,
  type MemoryDraft,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type MemoryVerifier,
  type MemoryView,
  type Result,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/** The reason a stale candidate is withdrawn with (M49 R2). One sentence, spelt once: it is stored
 *  on the row, printed on the page and asserted by the gate. */
export const STALE_CANDIDATE_REASON = 'stale candidate, never verified'

/** Everything the view needs, in one shape -- `condensedFrom` is what fills `MemoryView.sourceIds`
 *  (plan erratum E4), and it is the only reason this is not a bare `findMany`. */
const withSources = {
  condensedFrom: { select: { sourceMemoryId: true }, orderBy: { sourceMemoryId: 'asc' } },
} as const

type MemoryRow = Prisma.MemoryGetPayload<{ include: typeof withSources }>

/**
 * A stored row as a {@link MemoryView}: `Date`s become ISO strings and the two open vocabularies
 * (`confidence`, `verifiedBy`) are read back as their unions.
 *
 * A row whose `confidence` is a word the domain does not know reads as `interpretation` rather
 * than throwing -- every caller of this function renders a page or answers a CLI, and a
 * hand-edited row must not take the Knowledge tab down (`viewOf`'s own rule in `runbook.ts`).
 */
function viewOf(row: MemoryRow): MemoryView {
  return {
    id: row.id,
    type: row.type,
    scope: row.scope,
    companyId: row.companyId,
    workspaceId: row.workspaceId,
    slaveId: row.slaveId,
    title: row.title,
    body: row.body,
    status: row.status,
    confidence: (row.confidence === 'sourced' ? 'sourced' : 'interpretation') satisfies MemoryConfidence,
    capabilities: row.capabilities,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifiedBy:
      row.verifiedBy === 'verification' || row.verifiedBy === 'review' || row.verifiedBy === 'human'
        ? (row.verifiedBy satisfies MemoryVerifier)
        : null,
    supersededById: row.supersededById,
    removedReason: row.removedReason,
    sourceIds: row.condensedFrom.map((one) => one.sourceMemoryId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    provenance: {
      sourceKind: row.sourceKind,
      sourceRef: row.sourceRef,
      createdBy: row.createdBy,
      createdByUserId: row.createdByUserId,
      taskId: row.taskId,
      runId: row.runId,
      goalVersion: row.goalVersion,
    },
  }
}

/** The three fields an event about a memory needs. A {@link MemoryRow} is one; so is the narrow
 *  `select` {@link discardStaleCandidates} pages with, which is the point -- withdrawing a year of
 *  unverified reports must not load a year of bodies to announce them. */
interface EventSubject {
  readonly id: string
  readonly taskId: string | null
  readonly workspaceId: string | null
}

/** The `workspaceId` an event about this memory belongs to. A worker's lesson and a company's fact
 *  have none of their own, so the caller's workspace is used -- an event with no workspace reaches
 *  no stream at all. */
function eventWorkspace(row: EventSubject, fallback: string | null): string | null {
  return row.workspaceId ?? fallback
}

async function announceRecorded(row: MemoryRow, workspaceId: string | null, principal?: Principal): Promise<void> {
  const target = eventWorkspace(row, workspaceId)
  if (target === null) return
  await appendEvent({
    type: 'memory.recorded',
    workspaceId: target,
    // Plan erratum E13: the task travels on the ENVELOPE, where it is indexed and where the
    // Activity filter and the task drawer both read it.
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    ...(row.slaveId === null ? {} : { slaveId: row.slaveId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    actor: row.createdBy,
    payload: {
      memoryId: row.id,
      type: row.type,
      scope: row.scope,
      status: row.status,
      sourceKind: row.sourceKind,
    },
    userId: principal?.userId ?? row.createdByUserId ?? null,
  })
}

async function announceChanged(
  row: EventSubject,
  from: MemoryStatus,
  to: MemoryStatus,
  by: 'human' | 'system',
  workspaceId: string | null,
  reason?: string,
  principal?: Principal,
): Promise<void> {
  const target = eventWorkspace(row, workspaceId)
  if (target === null) return
  await appendEvent({
    type: 'memory.changed',
    workspaceId: target,
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    actor: by,
    payload: { memoryId: row.id, from, to, ...(reason === undefined ? {} : { reason }) },
    userId: principal?.userId ?? null,
  })
}

const dataOf = (draft: MemoryDraft): Prisma.MemoryUncheckedCreateInput => ({
  type: draft.type,
  scope: draft.scope,
  companyId: draft.companyId,
  workspaceId: draft.workspaceId,
  slaveId: draft.slaveId,
  title: draft.title,
  body: draft.body,
  status: draft.status,
  confidence: draft.confidence,
  sourceKind: draft.provenance.sourceKind,
  sourceRef: draft.provenance.sourceRef,
  createdBy: draft.provenance.createdBy,
  createdByUserId: draft.provenance.createdByUserId,
  taskId: draft.provenance.taskId,
  runId: draft.provenance.runId,
  goalVersion: draft.provenance.goalVersion,
  capabilities: [...draft.capabilities],
  verifiedAt: draft.status === 'verified' ? new Date() : null,
  verifiedBy: draft.verifiedBy,
})

/**
 * The one write behind every promotion (M49 R2).
 *
 * Validates first and writes second, so a malformed draft never reaches the column: the "exactly
 * one target" invariant lives in `memoryDraftSchema` rather than in a database CHECK (plan decision
 * D1), which makes THIS the place it is enforced.
 *
 * `supersedesTaskCandidates` (plan decision D3) is carried out inside the same transaction as the
 * insert: a fact that retired nothing, or a candidate retired by a fact that failed to land, are
 * both states a reader could not explain. The events are appended AFTER the commit, the way every
 * other verb in this package does it.
 *
 * `eventWorkspaceId` is the project the EVENT is read in, for a memory that has no workspace of
 * its own (M49 t3): a worker's lesson is `worker`-scoped by construction, so `memory.recorded` for
 * it had no stream to reach and the Activity page never saw a rejection being learnt from. The
 * caller that knows the project -- the orchestrator's `promote`, which holds the run -- passes it.
 * It changes NOTHING about the row: the scope target stays the worker, and this is only where the
 * event is filed.
 */
export async function recordMemory(
  draft: unknown,
  principal?: Principal,
  eventWorkspaceId?: string | null,
): Promise<Result<MemoryView, ControlRefusal>> {
  const parsed = parseMemoryDraft(draft)
  if (!parsed.ok) return err({ kind: 'invalid_memory', detail: parsed.error })
  const value = parsed.value

  const written = await prisma.$transaction(async (tx) => {
    const created = await tx.memory.create({ data: dataOf(value), include: withSources })
    if (!value.supersedesTaskCandidates || value.provenance.taskId === null) {
      return { created, retired: [] as MemoryRow[] }
    }
    const open = await tx.memory.findMany({
      // `id: { not: created.id }` because the insert above is already in this transaction: a
      // candidate observation that asked to retire its task's candidates would otherwise match
      // itself and be written as superseded by itself.
      where: { taskId: value.provenance.taskId, type: 'observation', status: 'candidate', id: { not: created.id } },
      include: withSources,
      orderBy: { createdAt: 'asc' },
    })
    if (open.length > 0) {
      await tx.memory.updateMany({
        where: { id: { in: open.map((one) => one.id) } },
        data: { status: 'superseded', supersededById: created.id },
      })
    }
    return { created, retired: open }
  })

  const home = value.workspaceId ?? eventWorkspaceId ?? null
  await announceRecorded(written.created, home, principal)
  for (const row of written.retired) {
    await announceChanged(row, 'candidate', 'superseded', 'system', row.workspaceId ?? home)
  }
  return ok(viewOf(written.created))
}

/** What a person types (M49 R4). Everything about provenance is decided HERE and never taken from
 *  the caller: a memory a person wrote says so, and an operator who could set `sourceKind` could
 *  make the record claim a verification that never happened (`ProfileSpec.source`'s own rule). */
export async function addMemory(input: unknown, principal?: Principal): Promise<Result<MemoryView, ControlRefusal>> {
  const shape = input as {
    workspaceId?: unknown
    companyId?: unknown
    slaveId?: unknown
    scope?: unknown
    type?: unknown
    title?: unknown
    body?: unknown
    capabilities?: unknown
  }
  // Every target but the one the scope names is dropped, not just the workspace (fix round 1): a
  // request that sent three would otherwise reach `memoryDraftSchema` naming two, and be refused as
  // a malformed draft rather than written as the memory the scope plainly describes.
  const draft = {
    type: shape.type,
    scope: shape.scope,
    companyId: shape.scope === 'company' ? (shape.companyId ?? null) : null,
    workspaceId: shape.scope === 'workspace' ? (shape.workspaceId ?? null) : null,
    slaveId: shape.scope === 'worker' ? (shape.slaveId ?? null) : null,
    title: typeof shape.title === 'string' ? capCodePoints(shape.title.trim(), MEMORY_TITLE_MAX) : shape.title,
    body: typeof shape.body === 'string' ? capCodePoints(shape.body.trim(), MEMORY_BODY_MAX) : shape.body,
    status: 'verified',
    confidence: 'interpretation',
    capabilities: shape.capabilities ?? [],
    verifiedBy: 'human',
    supersedesTaskCandidates: false,
    provenance: {
      sourceKind: 'human',
      sourceRef: null,
      createdBy: 'human',
      createdByUserId: principal?.userId ?? null,
      taskId: null,
      runId: null,
      goalVersion: null,
    },
  }
  return recordMemory(draft, principal)
}

/** A row, or the refusal that says why not. `editable` is the frozen check R4 names: a superseded
 *  or removed memory is history, and history does not change. */
async function editable(id: string): Promise<Result<MemoryRow, ControlRefusal>> {
  const row = await prisma.memory.findUnique({ where: { id }, include: withSources })
  if (row === null) return err({ kind: 'memory_not_found', memoryId: id })
  if (row.status === 'superseded' || row.status === 'removed') {
    return err({ kind: 'memory_not_editable', memoryId: id, status: row.status })
  }
  return ok(row)
}

/** A person says a candidate is true (M49 R4). */
export async function verifyMemory(id: string, principal?: Principal): Promise<Result<MemoryView, ControlRefusal>> {
  const found = await editable(id)
  if (!found.ok) return found
  const was = found.value.status
  if (was === 'verified') return ok(viewOf(found.value))
  // Conditional on the status the read above saw ({@link supersedeMemory}'s idiom). Keyed on `id`
  // alone this write would drag a memory somebody withdrew in the meantime back to `verified` --
  // and a withdrawn thing read as knowledge reaches the next prompt. No transaction is open here,
  // so the refusal is RETURNED rather than thrown.
  const claimed = await prisma.memory.updateMany({
    where: { id, status: was },
    data: { status: 'verified', verifiedAt: new Date(), verifiedBy: 'human' },
  })
  if (claimed.count !== 1) return raced(id)
  const updated = await prisma.memory.findUniqueOrThrow({ where: { id }, include: withSources })
  await announceChanged(updated, was, 'verified', 'human', updated.workspaceId, undefined, principal)
  return ok(viewOf(updated))
}

/** What a verb here answers when the row moved between its read and its write. The status is
 *  re-read rather than guessed: "it is frozen" without saying which of the two happened is not
 *  actionable, and by now somebody else's verb has decided which. */
async function raced(id: string): Promise<Result<never, ControlRefusal>> {
  const row = await prisma.memory.findUnique({ where: { id }, select: { status: true } })
  if (row === null) return err({ kind: 'memory_not_found', memoryId: id })
  return err({ kind: 'memory_not_editable', memoryId: id, status: row.status })
}

/** Thrown, never returned: it happens after a write inside `$transaction`, and a returned refusal
 *  there would COMMIT the insert it is refusing. Caught by {@link supersedeMemory} below. */
class MemoryRaceError extends Error {
  constructor(readonly memoryId: string) {
    super(`memory ${memoryId} changed while it was being corrected`)
    this.name = 'MemoryRaceError'
  }
}

/**
 * A person corrects a memory (M49 R4): a NEW verified row carrying the old one's provenance, and
 * the old one stamped `superseded` pointing at it.
 *
 * The old row's provenance is copied rather than re-derived, with `sourceRef` set to the id it
 * replaced: the correction's own history is "a person rewrote THAT", and losing which task and run
 * the knowledge came from would make a corrected memory less traceable than the one it fixed.
 */
export async function supersedeMemory(
  id: string,
  next: { readonly title: string; readonly body: string },
  principal?: Principal,
): Promise<Result<{ readonly superseded: MemoryView; readonly created: MemoryView }, ControlRefusal>> {
  const found = await editable(id)
  if (!found.ok) return found
  const old = found.value
  const validated = parseMemoryDraft({
    type: old.type,
    scope: old.scope,
    companyId: old.companyId,
    workspaceId: old.workspaceId,
    slaveId: old.slaveId,
    title: capCodePoints(next.title.trim(), MEMORY_TITLE_MAX),
    body: capCodePoints(next.body.trim(), MEMORY_BODY_MAX),
    status: 'verified',
    confidence: old.confidence === 'sourced' ? 'sourced' : 'interpretation',
    capabilities: old.capabilities,
    verifiedBy: 'human',
    supersedesTaskCandidates: false,
    provenance: {
      // A person wrote these words, whatever produced the memory they replace.
      sourceKind: 'human',
      sourceRef: old.id,
      createdBy: 'human',
      createdByUserId: principal?.userId ?? null,
      taskId: old.taskId,
      runId: old.runId,
      goalVersion: old.goalVersion,
    },
  })
  if (!validated.ok) return err({ kind: 'invalid_memory', detail: validated.error })

  let written: { readonly created: MemoryRow; readonly superseded: MemoryRow }
  try {
    written = await prisma.$transaction(async (tx) => {
      const inserted = await tx.memory.create({ data: dataOf(validated.value), include: withSources })
      // What the old row was a summary OF travels with the correction (fix round 1, minor 3): a
      // corrected condensation that lost its sources would show a person a paragraph with nothing
      // behind it, and `retrieveMemories` would then hand a run both the summary and the rows it
      // summarises.
      if (old.condensedFrom.length > 0) {
        await tx.memorySource.createMany({
          data: old.condensedFrom.map((one) => ({ memoryId: inserted.id, sourceMemoryId: one.sourceMemoryId })),
        })
      }
      // Conditional on the status this verb read: a memory somebody else removed or corrected while
      // this one was being typed must not be stamped twice.
      const claimed = await tx.memory.updateMany({
        where: { id: old.id, status: old.status },
        data: { status: 'superseded', supersededById: inserted.id },
      })
      if (claimed.count !== 1) {
        // A refusal after a write inside a transaction has to THROW, or Prisma commits the insert.
        throw new MemoryRaceError(old.id)
      }
      const created = await tx.memory.findUniqueOrThrow({ where: { id: inserted.id }, include: withSources })
      const superseded = await tx.memory.findUniqueOrThrow({ where: { id: old.id }, include: withSources })
      return { created, superseded }
    })
  } catch (error) {
    if (error instanceof MemoryRaceError) return raced(id)
    throw error
  }

  await announceRecorded(written.created, written.created.workspaceId, principal)
  await announceChanged(
    written.superseded,
    old.status,
    'superseded',
    'human',
    written.superseded.workspaceId,
    undefined,
    principal,
  )
  return ok({ superseded: viewOf(written.superseded), created: viewOf(written.created) })
}

/** Withdrawn, with a reason, and still in the table (M49 R1/R4). */
export async function removeMemory(
  id: string,
  reason: string,
  principal?: Principal,
): Promise<Result<MemoryView, ControlRefusal>> {
  const trimmed = reason.trim()
  if (trimmed === '') return err({ kind: 'invalid_memory', detail: 'a removal needs a reason' })
  const found = await editable(id)
  if (!found.ok) return found
  const was = found.value.status
  const capped = capCodePoints(trimmed, MEMORY_BODY_MAX)
  // Conditional on the status the read saw, for the same reason {@link verifyMemory}'s write is:
  // a memory somebody corrected while this reason was being typed would otherwise be stamped
  // `removed` on top of its `superseded`, and the row would carry a withdrawal nobody asked for.
  const claimed = await prisma.memory.updateMany({
    where: { id, status: was },
    data: { status: 'removed', removedReason: capped },
  })
  if (claimed.count !== 1) return raced(id)
  const updated = await prisma.memory.findUniqueOrThrow({ where: { id }, include: withSources })
  await announceChanged(updated, was, 'removed', 'human', updated.workspaceId, capped, principal)
  return ok(viewOf(updated))
}

export interface MemoryFilter {
  readonly workspaceId: string
  readonly scope?: MemoryScope
  readonly type?: MemoryType
  readonly statuses?: readonly MemoryStatus[]
  readonly taskId?: string
  readonly capability?: string
  /** A case-insensitive `contains` on the TITLE only (R6). Not the body: a search over paragraphs
   *  returns the memory that mentions a word rather than the one that is about it. */
  readonly q?: string
  readonly limit?: number
}

/** Which scope one of the three `OR` clauses below is about. A tiny helper so `filter.scope` can
 *  narrow the same list rather than a second `where` being built for it. */
function scopeOf(clause: Prisma.MemoryWhereInput): MemoryScope {
  if ('companyId' in clause) return 'company'
  if ('slaveId' in clause) return 'worker'
  return 'workspace'
}

/**
 * Everything this project can see, filtered (M49 R4).
 *
 * "This project can see" is the same three scopes a run is given: the workspace's own, its
 * company's, and the workers on it. One query with an `OR`, never three.
 */
export async function listMemories(filter: MemoryFilter): Promise<readonly MemoryView[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: filter.workspaceId },
    select: { companyId: true, teams: { select: { slaves: { select: { id: true } } } } },
  })
  if (workspace === null) return []
  const slaveIds = workspace.teams.flatMap((team) => team.slaves.map((slave) => slave.id))
  const scopes: Prisma.MemoryWhereInput[] = [{ workspaceId: filter.workspaceId }]
  if (workspace.companyId !== null) scopes.push({ companyId: workspace.companyId })
  if (slaveIds.length > 0) scopes.push({ slaveId: { in: slaveIds } })

  const rows = await prisma.memory.findMany({
    where: {
      OR: filter.scope === undefined ? scopes : scopes.filter((one) => scopeOf(one) === filter.scope),
      ...(filter.type === undefined ? {} : { type: filter.type }),
      ...(filter.statuses === undefined ? {} : { status: { in: [...filter.statuses] } }),
      ...(filter.taskId === undefined ? {} : { taskId: filter.taskId }),
      ...(filter.capability === undefined ? {} : { capabilities: { has: filter.capability } }),
      ...(filter.q === undefined || filter.q.trim() === ''
        ? {}
        : { title: { contains: filter.q.trim(), mode: 'insensitive' } }),
    },
    include: withSources,
    // Key-stable (R4): newest first, ties broken by id, so two reads of one unchanged table give
    // the same list in the same order.
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: filter.limit ?? MEMORIES_LOADED_MAX,
  })
  return rows.map(viewOf)
}

/**
 * The memories with these ids, in ONE query (M49 t4 fix round 1, minor 2).
 *
 * For a reader that already knows exactly which rows it wants -- the task drawer's "what this run
 * was GIVEN" list, whose ids come off a recorded manifest (plan erratum E7). `readMemory` per id
 * would be one point read plus three chain reads EACH, four queries for a row whose chain nobody
 * asked for.
 *
 * NO status filter: a memory a run was handed and that somebody has since withdrawn is still what
 * that run was handed, and a "received" list that quietly dropped it would be a false record of
 * what happened. An id nothing answers to is simply absent -- the row may be from another
 * installation's manifest, and a missing memory is not a refusal.
 *
 * Ordered `createdAt asc, id asc`, `readMemory`'s own chain ordering, so a panel renders the same
 * list in the same order between two reads of one unchanged table.
 */
export async function listMemoriesByIds(ids: readonly string[]): Promise<readonly MemoryView[]> {
  if (ids.length === 0) return []
  const rows = await prisma.memory.findMany({
    where: { id: { in: [...ids] } },
    include: withSources,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return rows.map(viewOf)
}

export interface MemoryChain {
  readonly memory: MemoryView
  /** Every row this one replaced, oldest first. A list and not one row (fix round 1, minor 5): a
   *  verified fact retires EVERY candidate its task left behind in one transaction (D3), so
   *  "what did this replace" has more than one answer whenever a task reported twice. */
  readonly supersedes: readonly MemoryView[]
  /** What replaced this one. */
  readonly supersededBy: MemoryView | null
  /** What it summarises, when it is a condensation (R5). */
  readonly sources: readonly MemoryView[]
}

/** One memory and the chain around it (M49 R4/R6) -- what it replaced, what replaced it, and what
 *  it is a summary of. */
export async function readMemory(id: string): Promise<Result<MemoryChain, ControlRefusal>> {
  const row = await prisma.memory.findUnique({ where: { id }, include: withSources })
  if (row === null) return err({ kind: 'memory_not_found', memoryId: id })
  const [supersedes, supersededBy, sources] = await Promise.all([
    prisma.memory.findMany({
      where: { supersededById: row.id },
      include: withSources,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    row.supersededById === null
      ? Promise.resolve(null)
      : prisma.memory.findUnique({ where: { id: row.supersededById }, include: withSources }),
    row.condensedFrom.length === 0
      ? Promise.resolve([])
      : prisma.memory.findMany({
          where: { id: { in: row.condensedFrom.map((one) => one.sourceMemoryId) } },
          include: withSources,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
  ])
  return ok({
    memory: viewOf(row),
    supersedes: supersedes.map(viewOf),
    supersededBy: supersededBy === null ? null : viewOf(supersededBy),
    sources: sources.map(viewOf),
  })
}

export interface MemoriesForRunInput {
  readonly workspaceId: string
  /** Null only for the re-plan preview, which picks no persona (plan erratum E14). */
  readonly slaveId: string | null
  readonly taskId: string | null
  readonly kind: 'implementation' | 'planning'
}

/**
 * What {@link memoriesForRun} answers: the twelve a prompt may carry, and how many QUALIFIED.
 *
 * Two numbers rather than one because they are two different facts (fix round 1, item 3):
 * `memories.length` is twelve both when twelve qualified and when six hundred did, and a caller
 * writing "there was more to say" on the run's manifest can only be honest about it with
 * `eligible`.
 */
export interface MemoriesForRun {
  readonly memories: readonly MemoryView[]
  /** Every memory that passed the three eligibility rules and the summary-source drop, before the
   *  twelve were taken off the top. Never less than `memories.length`. */
  readonly eligible: number
}

/**
 * The knowledge one run is given (M49 R3).
 *
 * ONE bounded query for all three scopes, then the pure ranking. Bounded at
 * `MEMORIES_LOADED_MAX` and ordered `createdAt desc, id asc` so the set handed to the ranking is
 * itself deterministic -- a workspace with six hundred memories must give the same twelve every
 * time, and "the newest five hundred" is a rule a reader can state.
 *
 * `retrieveMemories` is asked for the WHOLE ranked list (`limit: MEMORIES_LOADED_MAX`, the bound
 * the query itself already applied) and the twelve are taken here, so the count that says whether
 * anything was left out comes from the same rule that decided what to leave out. The ranking is
 * pure and total, so this costs one `slice` and no second pass.
 */
export async function memoriesForRun(input: MemoriesForRunInput): Promise<MemoriesForRun> {
  const [workspace, task] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { companyId: true, goalVersion: true } }),
    input.taskId === null
      ? Promise.resolve(null)
      : prisma.task.findUnique({
          where: { id: input.taskId },
          select: { requiredCapabilities: true, goalVersion: true },
        }),
  ])
  if (workspace === null) return { memories: [], eligible: 0 }

  const scopes: Prisma.MemoryWhereInput[] = [{ workspaceId: input.workspaceId }]
  if (workspace.companyId !== null) scopes.push({ companyId: workspace.companyId })
  if (input.slaveId !== null) scopes.push({ slaveId: input.slaveId })

  const rows = await prisma.memory.findMany({
    where: { status: 'verified', OR: scopes },
    include: withSources,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: MEMORIES_LOADED_MAX,
  })

  const ranked = retrieveMemories({
    memories: rows.map(viewOf),
    scopes: { companyId: workspace.companyId, workspaceId: input.workspaceId, slaveId: input.slaveId },
    refs: {
      taskId: input.taskId,
      requiredCapabilities: task?.requiredCapabilities ?? [],
      goalVersion: task?.goalVersion ?? workspace.goalVersion,
    },
    kind: input.kind,
    limit: MEMORIES_LOADED_MAX,
  })
  return { memories: ranked.slice(0, MEMORIES_IN_PROMPT), eligible: ranked.length }
}

/** How many OBSERVATION candidates have sat unverified for over a day (M49 R2, plan erratum E11).
 *  ONE count over `@@index([workspaceId, status, type, createdAt])`; no rows come back, which is
 *  why the Supervisor's loader can afford it on every tick with no gate in front of it. */
export async function staleCandidateCount(
  workspaceId: string,
  now: Date,
  tx: Pick<typeof prisma, 'memory'> = prisma,
): Promise<number> {
  return tx.memory.count({
    where: {
      workspaceId,
      type: 'observation',
      status: 'candidate',
      createdAt: { lt: new Date(now.getTime() - MEMORY_CANDIDATE_STALE_MS) },
    },
  })
}

/** How many stale candidates one page of {@link discardStaleCandidates} withdraws. A project that
 *  has been reporting unverified for a month is exactly the project this verb runs on, and loading
 *  every such row at once is the one unbounded read this file would otherwise have. Two hundred is
 *  `PRUNE_BATCH`'s own order of magnitude -- big enough that the ordinary case is one page. */
export const DISCARD_BATCH = 200

export interface DiscardOptions {
  /** The page size, for a test that wants to prove the loop takes a second page. */
  readonly batch?: number
}

/**
 * Withdraws every stale OBSERVATION candidate with a reason (M49 R2, plan erratum E12) -- the verb
 * the Supervisor's `discard_stale_candidates` arm carries out.
 *
 * Nothing is deleted: each row keeps its words, its provenance and the reason it was withdrawn,
 * and each move is a `memory.changed` a person can read on the timeline.
 *
 * Paged, and each page's write is conditional on the row still being a candidate observation (fix
 * round 1): a candidate somebody verified between this page's read and its write is knowledge, and
 * stamping it "never verified" would be a lie the row carries forever. The events are appended for
 * the rows that ACTUALLY changed -- read back by the reason this verb wrote -- so the timeline and
 * the table agree, and the count returned is the count a person is told.
 */
export async function discardStaleCandidates(
  workspaceId: string,
  now: Date = new Date(),
  principal?: Principal,
  options: DiscardOptions = {},
): Promise<number> {
  const size = options.batch ?? DISCARD_BATCH
  const before = new Date(now.getTime() - MEMORY_CANDIDATE_STALE_MS)
  // No cursor: every row this loop touches stops being a `candidate`, so it leaves the predicate
  // and the next page is the next set. A row that raced out of `candidate` on its own leaves it
  // too, which is why the loop always makes progress.
  const where = { workspaceId, type: 'observation', status: 'candidate', createdAt: { lt: before } } as const
  let total = 0
  for (;;) {
    const page = await prisma.memory.findMany({
      where,
      // The three fields an event needs and nothing else: withdrawing a year of reports must not
      // load a year of bodies.
      select: { id: true, taskId: true, workspaceId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: size,
    })
    if (page.length === 0) return total

    const ids = page.map((one) => one.id)
    await prisma.memory.updateMany({
      where: { id: { in: ids }, status: 'candidate', type: 'observation' },
      data: { status: 'removed', removedReason: STALE_CANDIDATE_REASON },
    })
    const changed = await prisma.memory.findMany({
      where: { id: { in: ids }, status: 'removed', removedReason: STALE_CANDIDATE_REASON },
      select: { id: true, taskId: true, workspaceId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    for (const row of changed) {
      await announceChanged(row, 'candidate', 'removed', 'human', workspaceId, STALE_CANDIDATE_REASON, principal)
    }
    total += changed.length
    if (page.length < size) return total
  }
}

/**
 * Condenses everything this project holds that is worth condensing (M49 R5).
 *
 * A person or a cron calls this, never the Supervisor and never a tick: R5 keeps it out of the
 * decision loop deliberately, because a summary is cheap to make and awkward to unmake.
 *
 * Every scope this project can see is offered to {@link condenseMemories}, one type at a time: the
 * workspace's own memories, and each worker's. The company's are NOT: a company's knowledge is
 * shared between projects, and one project's cron must not rewrite it.
 *
 * The insert and its `MemorySource` rows are ONE transaction -- a summary whose sources failed to
 * link is a memory that claims twenty sources and points at none, and retrieval would then show it
 * beside every one of them. The event is appended after the commit, as every other verb here does.
 *
 * The `type` reported back is the type that was SUMMARISED, which is not always the type that was
 * written: a worker's lessons condense into a procedure (R5's one automatic PROCEDURE), and the
 * caller asked about lessons.
 */
export async function condenseWorkspaceMemories(
  workspaceId: string,
  type?: MemoryType,
  principal?: Principal,
): Promise<readonly { readonly type: MemoryType; readonly memoryId: string; readonly sources: number }[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { teams: { select: { slaves: { select: { id: true } } } } },
  })
  if (workspace === null) return []
  const slaveIds = workspace.teams.flatMap((team) => team.slaves.map((slave) => slave.id))
  const types = type === undefined ? MEMORY_TYPES : [type]

  const targets: { readonly scope: MemoryScope; readonly targetId: string }[] = [
    { scope: 'workspace', targetId: workspaceId },
    // In id order, so a run over one project writes the same summaries in the same order twice.
    ...slaveIds.toSorted((a, b) => a.localeCompare(b)).map((id) => ({ scope: 'worker' as const, targetId: id })),
  ]

  const made: { type: MemoryType; memoryId: string; sources: number }[] = []
  for (const target of targets) {
    const rows = await prisma.memory.findMany({
      where: target.scope === 'workspace' ? { workspaceId: target.targetId } : { slaveId: target.targetId },
      include: withSources,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MEMORIES_LOADED_MAX,
    })
    const memories = rows.map(viewOf)
    for (const one of types) {
      const condensation = condenseMemories({ memories, scope: target.scope, targetId: target.targetId, type: one })
      if (condensation === null) continue
      const written = await prisma.$transaction(async (tx) => {
        const created = await tx.memory.create({ data: dataOf(condensation.draft), include: withSources })
        await tx.memorySource.createMany({
          data: condensation.sourceIds.map((sourceMemoryId) => ({ memoryId: created.id, sourceMemoryId })),
        })
        return tx.memory.findUniqueOrThrow({ where: { id: created.id }, include: withSources })
      })
      await announceRecorded(written, workspaceId, principal)
      made.push({ type: one, memoryId: written.id, sources: condensation.sourceIds.length })
    }
  }
  return made
}
