import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Prisma, prisma } from '@slave-of-ai/db/client'
import {
  NON_TERMINAL_RUN_STATUSES,
  isWorkspaceLimitAllowed,
  type Result,
  type WorkspaceLimitField,
  err,
  ok,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { ProviderKind } from '@slave-of-ai/providers'
import { realGitProbe, type GitProbe } from './git-probe.js'
import { isProviderKind } from './org.js'
import type { Principal } from './principal.js'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'

/**
 * Sets (or clears) the workspace's default runtime -- the last link of `resolveRuntime`'s override
 * chain, and until M13 a row nothing in this codebase could write.
 *
 * ONE TRANSACTION, DELETE-THEN-INSERT (Decision 9). `workspaceDefaultProvider` returns a default
 * only for a workspace with EXACTLY ONE `ProviderConfiguration` row -- more than one and it
 * returns `null`, because the table has no "this one is the default" column, so picking one would
 * be an arbitrary choice dressed up as a default. An upsert on `(workspaceId, kind)` would create
 * a SECOND row when the kind changes, which would silently stop every dispatch in the workspace.
 * Replacing is the only shape that keeps the rule true.
 *
 * `null` deletes: "this workspace has no configured default", which is a real state and not the
 * same as "the operator configured Claude".
 *
 * Deliberately NOT refused for a halted workspace (Decision 11) and deliberately NOT checked
 * against `Workspace.budgetUsd` (Decision 10): a cost-blind provider on a budgeted workspace is a
 * configuration dispatch refuses with `unmeasurable_budget`, and duplicating that refusal here
 * would make the pair unreachable in the order (provider first, budget second) an operator
 * naturally uses -- while telling them the same thing twice.
 */
export async function setWorkspaceProvider(
  workspaceId: string,
  kind: ProviderKind | null,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (kind !== null && !isProviderKind(kind)) return err({ kind: 'invalid_provider', provider: kind })

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const outcome = await prisma.$transaction(async (tx) => {
    // ONE WRITER AT A TIME (I1). Delete-then-insert is only "exactly one row or nothing" if nobody
    // else is between the two statements, and under READ COMMITTED nothing else here serialises
    // them: neither `deleteMany` sees the other transaction's uncommitted `create`, and
    // `@@unique([workspaceId, kind])` does not collide when the two writers pick DIFFERENT kinds.
    // Two concurrent kind changes therefore both delete nothing and both insert, leaving two rows
    // -- at which point `workspaceDefaultProvider` returns null and every dispatch in the workspace
    // throws, burning an attempt per task per tick (Task 3's `releaseTaskAfterFailure`). Locking the
    // `Workspace` row makes the second writer wait for the first to COMMIT, so its `deleteMany`
    // sees the committed row and replaces it. The lock is taken on the parent row rather than on
    // `ProviderConfiguration` because the rows being serialised are the ones that may not exist yet.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    // The workspace can be deleted between the read above and this lock; zero locked rows is the
    // same answer that read gives, spelled the same way.
    if (locked.length === 0) return { locked: false } as const

    const existing = await tx.providerConfiguration.findMany({ where: { workspaceId }, select: { kind: true } })
    await tx.providerConfiguration.deleteMany({ where: { workspaceId } })
    if (kind !== null) {
      // `settings: {}` -- the column has no reader anywhere in this codebase, and inventing a
      // shape for it now, with nothing to pass it to, is the mistake M12 Task 5 already caught
      // once. An empty object is the honest "nothing configured".
      await tx.providerConfiguration.create({ data: { workspaceId, kind, settings: {} } })
    }
    // The same "exactly one row or nothing" rule `workspaceDefaultProvider` reads by: a workspace
    // that somehow held two rows had no resolvable default, so `from` is honestly `null`.
    return { locked: true, from: existing.length === 1 ? existing[0]!.kind : null } as const
  })
  if (!outcome.locked) return err({ kind: 'workspace_not_found', workspaceId })
  const from = outcome.from

  await appendEvent({
    type: 'workspace.settings_changed',
    workspaceId,
    actor: 'human',
    payload: { field: 'provider', from, to: kind },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}

/**
 * Sets (or clears) the workspace's spend ceiling.
 *
 * `null` is the deliberate "this workspace is not budgeted" state -- spec §6's ONLY state in which
 * a cost-blind runtime may run. `0` is a budget an operator SET and is refused at dispatch as
 * firmly as any other figure, so it is accepted here.
 *
 * `Number.isFinite` rather than a bare `>= 0` check: `NaN >= 0` is `false` (so NaN is caught
 * either way) but `Infinity >= 0` is `true`, and an infinite ceiling written into a Float column
 * is a budget that can never be exceeded -- a guardrail that is silently inert, which is exactly
 * the shape M12 made this column nullable to avoid.
 */
export async function setWorkspaceBudget(
  workspaceId: string,
  usd: number | null,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (usd !== null && (!Number.isFinite(usd) || usd < 0)) return err({ kind: 'invalid_budget' })

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, budgetUsd: true },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  await prisma.workspace.update({ where: { id: workspaceId }, data: { budgetUsd: usd } })
  await appendEvent({
    type: 'workspace.settings_changed',
    workspaceId,
    actor: 'human',
    payload: { field: 'budgetUsd', from: workspace.budgetUsd, to: usd },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}

/**
 * Turns the project's auto-merge switch on or off (E R7).
 *
 * `Workspace.autoMerge` has existed since M8a and NO verb could write it: `merge.ts` reads it after
 * a review is approved and either merges the branch and stamps `Task.integratedAt`, or leaves both
 * to a person. So the column was a policy nobody could choose -- every project was hand-merge
 * unless somebody edited the database. This is the chooser.
 *
 * The returned `unintegratedDone` is the README's caveat made countable: turning the switch ON does
 * not retroactively stamp anything. Tasks that already reached `done` through a hand merge keep
 * `integratedAt: null` -- correct, because no merge happened through the new path -- and they go on
 * blocking their dependents until `confirmIntegration` is run on each of them once. The count is
 * what lets the CLI say so at the moment the switch is flipped, where somebody is reading; the
 * count is taken for both directions and simply ignored by a caller turning the switch off.
 *
 * No transaction and no lock: this is one boolean on one row, and two operators racing to set it
 * leave it at whatever the last writer said -- which is what "the last person to flip a switch
 * wins" means. The pair that needed serialising was `setWorkspaceProvider`'s delete-then-insert.
 *
 * Deliberately NOT refused for a halted or archived project: the web route answers `archived`
 * before the verb runs (`workspaceControlResponse`), and a halted project is one where changing how
 * finished work integrates is a reasonable thing to do while it is stopped.
 */
export async function setWorkspaceIntegration(
  workspaceId: string,
  settings: { readonly autoMerge: boolean },
  principal?: Principal,
): Promise<Result<{ readonly unintegratedDone: number }, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, autoMerge: true },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  await prisma.workspace.update({ where: { id: workspaceId }, data: { autoMerge: settings.autoMerge } })
  // The exact set `confirmIntegration` exists for: reviewed, verified, and still not on the base
  // branch. Counted AFTER the write, because the write stamps nothing -- that is the point.
  const unintegratedDone = await prisma.task.count({ where: { workspaceId, status: 'done', integratedAt: null } })

  await appendEvent({
    type: 'workspace.settings_changed',
    workspaceId,
    actor: 'human',
    payload: { field: 'autoMerge', from: workspace.autoMerge, to: settings.autoMerge },
    userId: principal?.userId ?? null,
  })
  return ok({ unintegratedDone })
}

/** The patch {@link setWorkspaceLimits} takes: any of the three, each optional. */
export interface WorkspaceLimitsPatch {
  /** Milliseconds, the column's own unit -- and a whole number of minutes (`isWorkspaceLimitAllowed`). */
  readonly runTimeoutMs?: number
  readonly maxConcurrentRuns?: number
  readonly maxAttempts?: number
}

/** One limit that moved: the `workspace.settings_changed` payload, handed back so a caller can say it. */
export interface WorkspaceLimitMove {
  readonly field: WorkspaceLimitField
  readonly from: number
  readonly to: number
}

/**
 * Sets any of the project's three dispatch limits (H9 F8): how long a run may work, how many runs
 * the project has at once, and how many attempts a task gets.
 *
 * `Workspace.runTimeoutMs` had no writer at all -- no verb, no route, the Runtime panel showed it
 * read-only -- so a project whose tasks legitimately take longer than thirty minutes could only be
 * helped by a hand edit of the database. The other two were in the same state outside the
 * simulation adopt path. This is the writer, bounded by `WORKSPACE_LIMIT_BOUNDS`.
 *
 * EVERY figure is checked before anything is written: a patch carrying one good limit and one bad
 * one writes neither, `setSupervisorSettings`' rule. One `workspace.settings_changed` per limit that
 * actually MOVED, and none when nothing did, so a re-save of an unchanged form says nothing.
 *
 * What each one reaches, which is why the caller is handed the moves back:
 * - `runTimeoutMs` is read live by the sweep, so a raised timeout reaches a run that is already
 *   working on the next pass. It also bounds each verify and merge command.
 * - `maxConcurrentRuns` is read by the next dispatch; a lowered one stops nothing already running.
 * - `maxAttempts` is COPIED onto a task when the task is planned (`Task.maxAttempts`), so it reaches
 *   tasks planned from now on only. A task already on the board keeps the ceiling it was created
 *   with, and `retry-task` is what moves that one.
 *
 * No transaction and no lock, `setWorkspaceBudget`'s shape: three integers on one row, and two
 * people racing to set them leave whatever the last writer said.
 *
 * Deliberately NOT refused for a halted project -- raising a timeout is a reasonable thing to do
 * while it is stopped -- and the web route answers `archived` before this runs.
 */
export async function setWorkspaceLimits(
  workspaceId: string,
  patch: WorkspaceLimitsPatch,
  principal?: Principal,
): Promise<Result<{ readonly moved: readonly WorkspaceLimitMove[] }, ControlRefusal>> {
  const fields: readonly WorkspaceLimitField[] = ['runTimeoutMs', 'maxConcurrentRuns', 'maxAttempts']
  for (const field of fields) {
    const value = patch[field]
    if (value !== undefined && !isWorkspaceLimitAllowed(field, value)) return err({ kind: 'invalid_limit', field })
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { runTimeoutMs: true, maxConcurrentRuns: true, maxAttempts: true },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const moved: WorkspaceLimitMove[] = []
  for (const field of fields) {
    const to = patch[field]
    if (to !== undefined && to !== workspace[field]) moved.push({ field, from: workspace[field], to })
  }
  if (moved.length === 0) return ok({ moved })

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: Object.fromEntries(moved.map((move) => [move.field, move.to])),
  })
  // One event per limit, in the table's order: a settings_changed is ONE field's move, which is
  // what lets the Activity card say "run timeout 30m → 60m" without decoding a bag.
  for (const move of moved) {
    await appendEvent({
      type: 'workspace.settings_changed',
      workspaceId,
      actor: 'human',
      payload: { field: move.field, from: move.from, to: move.to },
      userId: principal?.userId ?? null,
    })
  }
  return ok({ moved })
}

export interface CreateWorkspaceInput {
  readonly name: string
  readonly repoPath: string
  readonly baseBranch?: string
  readonly verifyCommands: readonly string[]
  readonly setupCommands?: readonly string[]
  readonly budgetUsd?: number | null
  readonly provider?: ProviderKind | null
  /**
   * E R7/R1: the two switches a project may be BORN with, both optional and both absent from every
   * caller but `acceptIntake`. Omitted, the columns' own defaults stand -- `autoMerge false`,
   * `supervisorAutonomy propose` -- so a project created from the CLI or the form still merges by
   * hand and still asks before the Supervisor acts. A project created from a conversation carries
   * the card's two checkboxes, which default on (`intakeDraftSchema`).
   */
  readonly autoMerge?: boolean
  readonly supervisorAutonomy?: 'propose' | 'act'
}

let probe: GitProbe = realGitProbe
/** Test seam only: swap the git probe. Not an operator knob. */
export function useGitProbe(next: GitProbe): void {
  probe = next
}

function cleanCommands(commands: readonly string[] | undefined): string[] {
  return (commands ?? []).map((command) => command.trim()).filter((command) => command.length > 0)
}

/** Spec §2 A1. Refusals in the spec's table order; nothing is written until every check passed.
 *
 *  `options.intakeId` (M59 R4) is the ONLY link between a project and the conversation that asked
 *  for it, and it rides on the `workspace.created` payload rather than in a column: the event log
 *  is where "why does this project exist" belongs, `Intake.workspaceId` is the other half of the
 *  pair, and neither needs a schema change on `Workspace`. Absent for every project created from
 *  the form or the CLI, which is every project before this milestone. */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  principal?: Principal,
  options: { readonly intakeId?: string } = {},
): Promise<Result<{ id: string }, ControlRefusal>> {
  const name = input.name.trim()
  if (name.length === 0) return err({ kind: 'invalid_name' })
  if (!isAbsolute(input.repoPath)) return err({ kind: 'repo_path_not_absolute', path: input.repoPath })
  const info = await stat(input.repoPath).catch(() => null)
  if (info === null || !info.isDirectory()) return err({ kind: 'repo_not_found', path: input.repoPath })
  if (!(await probe.isRepository(input.repoPath))) return err({ kind: 'not_a_git_repository', path: input.repoPath })
  const baseBranch = (input.baseBranch ?? 'main').trim() || 'main'
  if (!(await probe.branchExists(input.repoPath, baseBranch))) {
    return err({ kind: 'base_branch_not_found', path: input.repoPath, branch: baseBranch })
  }
  const verifyCommands = cleanCommands(input.verifyCommands)
  if (verifyCommands.length === 0) return err({ kind: 'verify_commands_empty' })
  const budgetUsd = input.budgetUsd
  if (budgetUsd !== undefined && budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
    return err({ kind: 'invalid_budget' })
  }
  const provider = input.provider ?? null
  if (provider !== null && !isProviderKind(provider)) return err({ kind: 'invalid_provider', provider })

  let id: string
  try {
    id = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name,
          repoPath: input.repoPath,
          baseBranch,
          verifyCommands,
          setupCommands: cleanCommands(input.setupCommands),
          ...(budgetUsd === undefined ? {} : { budgetUsd }),
          // Spread, not `autoMerge: input.autoMerge ?? false`: restating a column's default in
          // TypeScript is how the two drift apart, and "the caller said nothing" has exactly one
          // right answer here -- let Postgres answer it.
          ...(input.autoMerge === undefined ? {} : { autoMerge: input.autoMerge }),
          ...(input.supervisorAutonomy === undefined ? {} : { supervisorAutonomy: input.supervisorAutonomy }),
        },
      })
      if (provider !== null) {
        await tx.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: provider, settings: {} } })
      }
      return workspace.id
    })
  } catch (cause) {
    if (isUniqueConstraintViolation(cause)) return err({ kind: 'duplicate_name', name })
    throw cause
  }
  await appendEvent({
    type: 'workspace.created',
    workspaceId: id,
    actor: 'human',
    // Spread, not `intakeId: options.intakeId ?? undefined`: a project created from the form must
    // carry NO `intakeId` key at all, so a reader can tell "no conversation made this" from "one
    // did and its id will not parse" -- the rule `goal.ts:202-204` already states for `request`.
    payload: {
      name,
      repoPath: input.repoPath,
      baseBranch,
      verifyCommands,
      provider,
      ...(options.intakeId === undefined ? {} : { intakeId: options.intakeId }),
    },
    userId: principal?.userId ?? null,
  })
  return ok({ id })
}

export interface Footprint {
  readonly departments: number
  readonly slaves: number
  readonly tasks: number
  readonly runs: number
}

/** What a project holds (M27 §3.4's confirm text, §7's `ProjectSettings.footprint`). Four counts,
 *  one round trip each; `db` is a transaction client inside the verbs and `prisma` for reads. */
export async function projectFootprint(db: Prisma.TransactionClient | typeof prisma, workspaceId: string): Promise<Footprint> {
  const [departments, slaves, tasks, runs] = await Promise.all([
    db.team.count({ where: { workspaceId } }),
    db.slave.count({ where: { team: { workspaceId } } }),
    db.task.count({ where: { workspaceId } }),
    db.slaveRun.count({ where: { slave: { team: { workspaceId } } } }),
  ])
  return { departments, slaves, tasks, runs }
}

/** Non-terminal runs anywhere in the project -- the one definition every M27 verb refuses on. */
export async function liveRunCount(db: Prisma.TransactionClient | typeof prisma, where: { workspaceId: string } | { teamId: string } | { slaveId: string }): Promise<number> {
  const status = { in: [...NON_TERMINAL_RUN_STATUSES] }
  if ('slaveId' in where) return db.slaveRun.count({ where: { slaveId: where.slaveId, status } })
  if ('teamId' in where) return db.slaveRun.count({ where: { slave: { teamId: where.teamId }, status } })
  return db.slaveRun.count({ where: { slave: { team: { workspaceId: where.workspaceId } }, status } })
}

/**
 * Archives a project (M27 §3): every row stays, `archivedAt` is set, and from then on `tick()`
 * skips it, `admitRun` refuses it and every list hides it. Refused while a run is live -- an
 * archived project must have nothing in flight. A halt already in place is left alone.
 *
 * "Nothing in flight" holds against a concurrent dispatch only because of what the other side
 * does (final review, ruling R15). The `FOR UPDATE` below locks the `Workspace` row; a `SlaveRun`
 * insert takes `FOR KEY SHARE` on the `Slave` row it references, which does not conflict with it,
 * so this lock on its own could not serialise the pair. The orchestrator's
 * `createRunUnlessArchived` re-reads `archivedAt` under `FOR SHARE` on THIS row inside the
 * transaction that inserts the run -- and `FOR SHARE` does conflict with `FOR UPDATE`. Either the
 * run commits first and the live-run count below sees it and refuses, or this commits first and
 * the dispatch reads `archivedAt` set and starts nothing.
 */
export async function archiveWorkspace(
  workspaceId: string,
  principal?: Principal,
): Promise<Result<{ readonly footprint: Footprint }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, archivedAt: true } })
    if (workspace === null) return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId } as ControlRefusal }
    if (workspace.archivedAt !== null) return { ok: false as const, error: { kind: 'already_archived', workspaceId } as ControlRefusal }
    const runs = await liveRunCount(tx, { workspaceId })
    if (runs > 0) return { ok: false as const, error: { kind: 'live_runs', entity: 'workspace', id: workspaceId, runs } as ControlRefusal }
    const footprint = await projectFootprint(tx, workspaceId)
    await tx.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } })
    return { ok: true as const, value: { name: workspace.name, footprint } }
  })
  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'workspace.archived',
    workspaceId,
    actor: 'human',
    payload: { name: outcome.value.name, ...outcome.value.footprint },
    userId: principal?.userId ?? null,
  })
  return ok({ footprint: outcome.value.footprint })
}

/** Undoes {@link archiveWorkspace}. A halt that predates the archive stays. */
export async function restoreWorkspace(
  workspaceId: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, archivedAt: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.archivedAt === null) return err({ kind: 'not_archived', workspaceId })
  // The clear is conditional on the row still being archived, so two restores racing each other
  // (both past the read above) clear it once and emit `workspace.restored` once -- the loser sees
  // `count: 0` and answers `not_archived`, the same as if it had arrived a moment later.
  const cleared = await prisma.workspace.updateMany({ where: { id: workspaceId, archivedAt: { not: null } }, data: { archivedAt: null } })
  if (cleared.count === 0) return err({ kind: 'not_archived', workspaceId })
  await appendEvent({
    type: 'workspace.restored',
    workspaceId,
    actor: 'human',
    payload: { name: workspace.name },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}
