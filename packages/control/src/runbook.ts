import { RUNBOOK_SEED } from '@slave-of-ai/db'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  RUNBOOK_KEY_PATTERN,
  err,
  measureAdherence,
  ok,
  parseRunbookStages,
  runbookSourceOf,
  stageOrder,
  type Result,
  type Runbook,
  type RunbookStage,
  type TaskStatus,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'

/** A runbook as every surface reads it: the domain shape plus the one fact only the database has. */
export interface RunbookView extends Runbook {
  /** How many projects have adopted it -- what the Workforce tab shows and what makes a `human`
   *  runbook nobody uses visibly different from one three projects follow. */
  readonly workspaceCount: number
}

interface RunbookRow {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly description: string
  readonly keywords: string[]
  readonly requiredCapabilities: string[]
  readonly optionalCapabilities: string[]
  readonly stages: Prisma.JsonValue
  readonly source: string
  readonly sourceTemplateId: string | null
}

/**
 * A stored row as a {@link Runbook}.
 *
 * A row whose `stages` will not parse comes back with NO stages rather than throwing: every reader
 * of this function renders a page or answers a CLI, and a hand-edited row must not take the
 * Workforce tab down. Such a runbook measures no adherence, recommends nothing useful and shows an
 * empty stage list -- which is the honest rendering of a row nothing can read.
 */
function viewOf(row: RunbookRow, workspaceCount: number): RunbookView {
  const parsed = parseRunbookStages(row.stages)
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    keywords: row.keywords,
    requiredCapabilities: row.requiredCapabilities,
    optionalCapabilities: row.optionalCapabilities,
    stages: parsed.ok ? parsed.value : [],
    source: runbookSourceOf(row.source),
    sourceTemplateId: row.sourceTemplateId,
    workspaceCount,
  }
}

const jsonStages = (stages: readonly RunbookStage[]): Prisma.InputJsonValue =>
  stages as unknown as Prisma.InputJsonValue

/**
 * A stage list as ONE string, field order fixed here (`handoffCanonicalJson`'s idiom).
 *
 * `JSON.stringify` over a stored `jsonb` value cannot be compared with `JSON.stringify` over the
 * checked-in literal: Postgres stores a `jsonb` object with its OWN key order (shortest key first,
 * then alphabetical), so a row that is byte-identical in meaning serialises differently on the way
 * back and {@link syncRunbooks} reported every seed row as updated on every run, forever. Projecting
 * both sides through the same nine fields is what makes "unchanged" mean unchanged.
 */
const canonicalStages = (stages: readonly RunbookStage[]): string =>
  JSON.stringify(
    stages.map((stage) => ({
      key: stage.key,
      title: stage.title,
      objective: stage.objective,
      capabilities: [...stage.capabilities],
      dependsOn: [...stage.dependsOn],
      expectedOutputs: [...stage.expectedOutputs],
      gates: [...stage.gates],
      retry: stage.retry === null ? null : { maxAttempts: stage.retry.maxAttempts },
      escalation: stage.escalation,
    })),
  )

/**
 * Reconcile the `RunbookTemplate` table against the checked-in list (R3).
 *
 * SEED ROWS ONLY. A row an operator wrote (`human`) or the importer translated (`persona`) is never
 * read and never written here: `syncCapabilityTaxonomy`'s own rule, and the reason a sync is safe
 * to run on every import. Cheap and idempotent -- `{ created: 0, updated: 0 }` every time after the
 * first, which is what the CLI prints.
 */
export async function syncRunbooks(): Promise<{ readonly created: number; readonly updated: number }> {
  let created = 0
  let updated = 0
  for (const runbook of RUNBOOK_SEED) {
    const existing = await prisma.runbookTemplate.findUnique({ where: { key: runbook.key } })
    const data = {
      name: runbook.name,
      description: runbook.description,
      keywords: [...runbook.keywords],
      requiredCapabilities: [...runbook.requiredCapabilities],
      optionalCapabilities: [...runbook.optionalCapabilities],
      stages: jsonStages(runbook.stages),
      source: 'seed',
    }
    if (existing === null) {
      await prisma.runbookTemplate.create({ data: { key: runbook.key, ...data } })
      created += 1
      continue
    }
    // An operator's own row under a seed key wins, exactly as a hand-made template wins a name.
    if (existing.source !== 'seed') continue
    // A stored row whose stages will not parse is never "the same": the sync is what repairs it.
    const storedStages = parseRunbookStages(existing.stages)
    const same =
      existing.name === data.name &&
      existing.description === data.description &&
      JSON.stringify(existing.keywords) === JSON.stringify(data.keywords) &&
      JSON.stringify(existing.requiredCapabilities) === JSON.stringify(data.requiredCapabilities) &&
      JSON.stringify(existing.optionalCapabilities) === JSON.stringify(data.optionalCapabilities) &&
      storedStages.ok &&
      canonicalStages(storedStages.value) === canonicalStages(runbook.stages)
    if (same) continue
    await prisma.runbookTemplate.update({ where: { key: runbook.key }, data })
    updated += 1
  }
  return { created, updated }
}

/** Every runbook, KEY ASCENDING -- the order the checked-in list is written in, so `runbooks list`
 *  and `packages/db/src/runbooks.ts` read as two copies of one order. */
export async function listRunbooks(): Promise<readonly RunbookView[]> {
  const rows = await prisma.runbookTemplate.findMany({
    orderBy: { key: 'asc' },
    include: { _count: { select: { workspaces: true } } },
  })
  return rows.map((row) => viewOf(row, row._count.workspaces))
}

export async function readRunbook(key: string): Promise<Result<RunbookView, ControlRefusal>> {
  const row = await prisma.runbookTemplate.findUnique({
    where: { key },
    include: { _count: { select: { workspaces: true } } },
  })
  if (row === null) return err({ kind: 'runbook_not_found', key })
  return ok(viewOf(row, row._count.workspaces))
}

/**
 * An operator's own runbook, from one JSON object (R5, `runbooks add --file`).
 *
 * `source` is FORCED to `human` whatever the file says (plan decision D8): a row written by hand
 * under `source: 'seed'` would be rewritten by the next `syncRunbooks()`, silently, and the
 * operator would conclude the verb does not work. There is no editor UI in this milestone
 * (spec §3) -- this verb and the file are the whole of it.
 */
export async function addRunbook(input: unknown, by?: string): Promise<Result<RunbookView, ControlRefusal>> {
  if (typeof input !== 'object' || input === null) {
    return err({ kind: 'invalid_runbook', detail: 'the file must hold one JSON object' })
  }
  const draft = input as Record<string, unknown>
  const key = typeof draft['key'] === 'string' ? draft['key'] : ''
  if (!RUNBOOK_KEY_PATTERN.test(key)) {
    return err({ kind: 'invalid_runbook', detail: `"${key}" is not a runbook key: a key is a lower-case dash-separated slug` })
  }
  const name = typeof draft['name'] === 'string' && draft['name'] !== '' ? draft['name'] : null
  const description = typeof draft['description'] === 'string' && draft['description'] !== '' ? draft['description'] : null
  if (name === null || description === null) {
    return err({ kind: 'invalid_runbook', detail: 'a runbook needs a name and a description' })
  }

  const stages = parseRunbookStages(draft['stages'])
  if (!stages.ok) return err({ kind: 'invalid_runbook', detail: stages.error })

  const strings = (field: string): string[] => {
    const value = draft[field]
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }

  const taken = err<ControlRefusal>({
    kind: 'invalid_runbook',
    detail: `a runbook with the key "${key}" already exists`,
  })
  const existing = await prisma.runbookTemplate.findUnique({ where: { key } })
  if (existing !== null) return taken

  // `by` is the operator's name on the CLI. Recorded nowhere yet -- a runbook is not workspace-
  // scoped, and `ExecutionEvent` is; the import log is M46's answer for catalog provenance and a
  // runbook log is not this milestone's scope (spec §3).
  void by

  try {
    const row = await prisma.runbookTemplate.create({
      data: {
        key,
        name,
        description,
        keywords: strings('keywords'),
        requiredCapabilities: strings('requiredCapabilities'),
        optionalCapabilities: strings('optionalCapabilities'),
        stages: jsonStages(stages.value),
        source: 'human',
      },
      include: { _count: { select: { workspaces: true } } },
    })
    return ok(viewOf(row, row._count.workspaces))
  } catch (error) {
    // The read above and this insert are two statements with nothing serialising them, so two
    // operators adding the same key at once both read "free" (`org.ts`' own reason for catching
    // rather than trusting a pre-query). The unique index is the real gate; the loser is told the
    // same thing the pre-check would have told it, rather than being handed a raw P2002.
    if (isUniqueConstraintViolation(error)) return taken
    throw error
  }
}

export interface AdoptOutcome {
  readonly adopted: RunbookView | null
  readonly cleared: boolean
  /** False when the workspace was already in the state asked for -- then nothing is written and
   *  nothing is logged (plan erratum E9, the `goal_unchanged` precedent). */
  readonly changed: boolean
}

/** What the transaction below decided, before the event that reports it is appended. `event` is
 *  null for the two no-op cases: a clear of nothing, and a re-adoption of the runbook already on
 *  the row. */
interface AdoptDecision {
  readonly outcome: AdoptOutcome
  readonly event: { readonly runbookId: string; readonly key: string; readonly name: string; readonly cleared?: boolean } | null
}

/**
 * Adopt a runbook for a project, or clear the adopted one (R5).
 *
 * ONE verb for both, because they are one column. A human reaches it three ways -- the CLI's
 * `adopt-runbook`, the Overview's Adopt button, and `applyDecision`'s `adopt_runbook` arm -- and
 * all three write the same event with the same actor rule: `origin: 'human'` is a person, `system`
 * is a tick carrying out a decision a person approved.
 *
 * Adopting while tasks exist is ALLOWED (R5): the next re-plan sees it, and the planning section is
 * only ever rendered for the run that plans. Nothing re-plans automatically -- that is spec §3.
 *
 * The read, the decision and the write are ONE locked transaction on the `Workspace` row, the
 * `writeGoalVersion` idiom: without it two adopts race on the same column and the loser's event
 * reports a runbook the project is not following. Both refusals are reached BEFORE anything is
 * written, so returning them as values is safe -- a refusal after a write inside a transaction
 * would have to throw, or Prisma would commit that write. The event is appended after the commit,
 * exactly as `setGoal` does.
 */
export async function adoptRunbook(
  workspaceId: string,
  key: string | null,
  opts: { readonly origin?: 'human' | 'system' } = {},
  principal?: Principal,
): Promise<Result<AdoptOutcome, ControlRefusal>> {
  const decided = await prisma.$transaction(async (tx): Promise<Result<AdoptDecision, ControlRefusal>> => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      include: { runbook: { include: { _count: { select: { workspaces: true } } } } },
    })
    if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

    if (key === null) {
      const previous = workspace.runbook
      // Nothing to clear is not a refusal: the project is already in the state asked for, and the
      // caller is told `changed: false` rather than being handed an error for a no-op.
      if (previous === null) return ok({ outcome: { adopted: null, cleared: true, changed: false }, event: null })
      await tx.workspace.update({ where: { id: workspaceId }, data: { runbookId: null } })
      return ok({
        outcome: { adopted: null, cleared: true, changed: true },
        // Plan erratum E9: a clear has no runbook of its own to name, so it names the one it removed.
        event: { runbookId: previous.id, key: previous.key, name: previous.name, cleared: true },
      })
    }

    const row = await tx.runbookTemplate.findUnique({ where: { key } })
    if (row === null) return err({ kind: 'runbook_not_found', key })
    if (workspace.runbookId === row.id) {
      return ok({
        outcome: { adopted: viewOf(row, workspace.runbook?._count.workspaces ?? 0), cleared: false, changed: false },
        event: null,
      })
    }

    await tx.workspace.update({ where: { id: workspaceId }, data: { runbookId: row.id } })
    // Counted AFTER the write, so the view handed back to a CLI that has just adopted says "1
    // project" rather than the zero it read a line earlier.
    const workspaceCount = await tx.workspace.count({ where: { runbookId: row.id } })
    return ok({
      outcome: { adopted: viewOf(row, workspaceCount), cleared: false, changed: true },
      event: { runbookId: row.id, key: row.key, name: row.name },
    })
  })

  if (!decided.ok) return decided
  if (decided.value.event !== null) {
    await appendEvent({
      type: 'workspace.runbook_adopted',
      workspaceId,
      actor: opts.origin === 'system' ? 'system' : 'human',
      payload: decided.value.event,
      userId: principal?.userId ?? null,
    })
  }
  return ok(decided.value.outcome)
}

/** The adopted runbook as the DOMAIN shape, or null. The one read the orchestrator makes -- it
 *  needs the stages for the run-context section, the stage `retry` at plan time and the stage
 *  `gates` at verify time, and never needs `workspaceCount`. */
export async function runbookForWorkspace(workspaceId: string): Promise<Runbook | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { runbook: { include: { _count: { select: { workspaces: true } } } } },
  })
  const row = workspace?.runbook ?? null
  return row === null ? null : viewOf(row, row._count.workspaces)
}

export interface RunbookStatusView {
  readonly runbook: RunbookView | null
  readonly currentStage: string | null
  readonly stagesCovered: readonly string[]
  readonly stagesMissing: readonly string[]
  readonly unknownStages: readonly string[]
  readonly stages: readonly {
    readonly key: string
    readonly title: string
    readonly taskCount: number
    readonly state: 'done' | 'active' | 'pending' | 'missing'
  }[]
}

/**
 * Where this project is in its runbook (R6) -- what `runbook-status` prints and what the Overview's
 * panel renders.
 *
 * The four stage states are the four things a person can be told, read AGAINST the current stage
 * rather than off the task counts alone (fix round 1, Important 1):
 * - `active` -- it IS the current stage, whether or not any task has reached it yet. Checked first,
 *   because the alternative is a panel saying "current stage: Design" over a row saying design was
 *   skipped, which is what a board on the day a runbook is adopted looks like.
 * - `done` -- it is BEFORE the current stage and has tasks. Every one of them is terminal by
 *   construction: the current stage is the first with a live task.
 * - `missing` -- it is BEFORE the current stage and has none. This is the only honest reading of
 *   "the plan skipped it", and the measurement this milestone exists to make.
 * - `pending` -- it is AFTER the current stage. Not reached is not skipped, with tasks or without.
 *
 * ONE derivation, here, so the CLI and the page cannot disagree about which stage a project is on.
 */
export async function runbookStatus(workspaceId: string): Promise<Result<RunbookStatusView, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: { runbook: { include: { _count: { select: { workspaces: true } } } } },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const row = workspace.runbook
  if (row === null) {
    return ok({ runbook: null, currentStage: null, stagesCovered: [], stagesMissing: [], unknownStages: [], stages: [] })
  }
  const runbook = viewOf(row, row._count.workspaces)

  const tasks = await prisma.task.findMany({ where: { workspaceId }, select: { id: true, stage: true, status: true } })
  const adherence = measureAdherence(
    runbook.stages,
    tasks.map((task) => ({ id: task.id, stage: task.stage, status: task.status as TaskStatus })),
  )
  // Counts only. Whether a stage's work is FINISHED is not asked here: `measureAdherence` already
  // decided where the live work is, and the ladder below reads every other state off that one
  // answer -- a second opinion about terminality is exactly how the CLI and the panel drift apart.
  const countByStage = new Map<string, number>()
  for (const task of tasks) {
    if (task.stage === null) continue
    countByStage.set(task.stage, (countByStage.get(task.stage) ?? 0) + 1)
  }

  // `-1` only when the runbook has no stages at all -- a row whose `stages` will not parse, which
  // `viewOf` reads as an empty list. There is then nothing to label, so the branch it feeds is
  // unreachable; it is written defensively rather than asserted away.
  const ordered = stageOrder(runbook.stages)
  const currentIndex = ordered.findIndex((stage) => stage.key === adherence.currentStage)

  return ok({
    runbook,
    currentStage: adherence.currentStage,
    stagesCovered: adherence.stagesCovered,
    stagesMissing: adherence.stagesMissing,
    unknownStages: adherence.unknownStages,
    stages: ordered.map((stage, index) => {
      const taskCount = countByStage.get(stage.key) ?? 0
      const state =
        index === currentIndex
          ? 'active'
          : currentIndex !== -1 && index < currentIndex
            ? taskCount === 0
              ? 'missing'
              : 'done'
            : 'pending'
      return { key: stage.key, title: stage.title, taskCount, state }
    }),
  })
}
