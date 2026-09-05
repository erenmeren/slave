import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { NON_TERMINAL_RUN_STATUSES, type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { PROVIDER_KINDS, type ProviderKind } from '@slave-of-ai/providers'
import { admitProvider } from './budget.js'
import type { Principal } from './principal.js'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'
import { resolveRuntime, workspaceDefaultProvider } from './runtime.js'
import { liveRunCount } from './workspace.js'

/**
 * Validates an UNTRUSTED provider string (a CLI flag, a web request body). `PROVIDER_KINDS`
 * itself (M12 Task 13 fix round 1) lives in `@slave-of-ai/providers` -- the one canonical,
 * compile-time-guarded list, see that module's `types.ts` docstring -- rather than a private copy
 * here that could drift from it. Exported (M23 A1) so `workspace.ts`'s `createWorkspace` uses
 * this SAME definition rather than growing a second copy (the M17 census rule).
 */
export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value)
}

/**
 * The pair rule (M12 Task 7): a model only means something inside a provider, so the two columns
 * always move together -- both set, or both `null`. `undefined` reads as "this half was not
 * supplied" for both, so an options bag that omits both is the ordinary "leave unset" case, not a
 * violation; supplying exactly one of the two is what this catches. Returns the `model_without_
 * provider` refusal object -- the same kind covers "provider with no model" too (the brief's own
 * wording: "setting one without the other").
 */
function pairRefusal(
  model: string | null | undefined,
  provider: string | null | undefined,
): { readonly kind: 'model_without_provider' } | null {
  const hasModel = model !== null && model !== undefined
  const hasProvider = provider !== null && provider !== undefined
  return hasModel !== hasProvider ? { kind: 'model_without_provider' } : null
}

/**
 * Adds a reusable slave template to the catalog (M10 §4) -- the definition `addCompanySlave`
 * below instantiates onto a company's roster. Templates are append-only (Decision 9): there is no
 * update or delete here, only creation.
 *
 * NO budget admission here, and the absence is deliberate rather than an oversight (M12 Task 9,
 * spec §6). A template belongs to the catalog, not to a workspace: the same template is
 * instantiated onto rosters that are assignable to ANY workspace, so at this moment there is no
 * `budgetUsd` in existence to check a `reportsCost: false` provider against. The same is true of
 * `addCompanySlave` below. Adding a check here would either have to invent a workspace or refuse
 * a cost-blind provider globally -- which would make the second runtime uncatalogable and this
 * milestone pointless. The mismatch is caught at the two places it can actually be CREATED,
 * `assignCompany` and `setSlaveModel`, and again at dispatch.
 */
export async function createTemplate(
  name: string,
  role: string,
  options?: { readonly description?: string; readonly defaultModel?: string; readonly provider?: ProviderKind },
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '' || role.trim() === '') return err({ kind: 'invalid_name' })
  if (options?.defaultModel !== undefined && options.defaultModel.trim() === '') {
    return err({ kind: 'invalid_model' })
  }
  if (options?.provider !== undefined && !isProviderKind(options.provider)) {
    return err({ kind: 'invalid_provider', provider: options.provider })
  }
  const pairErr = pairRefusal(options?.defaultModel, options?.provider)
  if (pairErr !== null) return err(pairErr)

  try {
    const template = await prisma.slaveTemplate.create({
      data: {
        name,
        role,
        ...(options?.description !== undefined ? { description: options.description } : {}),
        ...(options?.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
        ...(options?.provider !== undefined ? { provider: options.provider } : {}),
      },
    })
    return ok({ id: template.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/** Adds a company -- a persistent roster (M10 §4) -- to the catalog. */
export async function createCompany(name: string): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  try {
    const company = await prisma.company.create({ data: { name } })
    return ok({ id: company.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/** Adds a team to a company's roster. Team names are unique per company, not globally. */
export async function addCompanyTeam(
  companyId: string,
  name: string,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } })
  if (company === null) return err({ kind: 'company_not_found', companyId })

  try {
    const team = await prisma.companyTeam.create({ data: { companyId, name } })
    return ok({ id: team.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/**
 * Adds a roster member -- a durable identity such as "Atlas" -- to a company team, instantiated
 * from a template. Slave names are unique per team, not globally: the same name in two different
 * teams (even in the same company) is unrelated identities and is allowed.
 *
 * Workspace-independent, like `createTemplate` above, and so deliberately carries no budget
 * admission -- see that function's comment for the reasoning.
 */
export async function addCompanySlave(
  companyTeamId: string,
  templateId: string,
  name: string,
  options?: { readonly model?: string; readonly provider?: ProviderKind },
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })
  if (options?.model !== undefined && options.model.trim() === '') return err({ kind: 'invalid_model' })
  if (options?.provider !== undefined && !isProviderKind(options.provider)) {
    return err({ kind: 'invalid_provider', provider: options.provider })
  }
  const pairErr = pairRefusal(options?.model, options?.provider)
  if (pairErr !== null) return err(pairErr)

  const team = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { id: true } })
  if (team === null) return err({ kind: 'company_team_not_found', companyTeamId })

  const template = await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { id: true } })
  if (template === null) return err({ kind: 'template_not_found', templateId })

  try {
    const slave = await prisma.companySlave.create({
      data: {
        companyTeamId,
        templateId,
        name,
        ...(options?.model !== undefined ? { model: options.model } : {}),
        ...(options?.provider !== undefined ? { provider: options.provider } : {}),
      },
    })
    return ok({ id: slave.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/**
 * Spec §6's write-time admission for `assignCompany` (M12 Task 9, controller ruling R6): a
 * budgeted workspace will not accept a roster whose members would run on a runtime that cannot
 * report what it spends. Returns the refusal, or `null` to proceed.
 *
 * Run BEFORE the transaction, not inside it, and that ordering is the point: the refusal must
 * leave the workspace exactly as it was. A check inside the transaction would work too, but
 * `assignCompany`'s transaction writes `companyId` first and materializes afterwards, so a
 * mid-transaction refusal would depend on the rollback for correctness where nothing needs to be
 * written in the first place. Nothing here can go stale between the check and the write in a way
 * that matters: the one-way `companyId` lock inside the transaction still guards the assignment
 * itself, and a roster edit racing this check is caught again at dispatch (spec §6's second half,
 * which exists precisely because resolution crosses four levels).
 *
 * Every roster member is examined, not only the ones this call will newly materialize. A re-sync
 * that skips an already-materialized worker still leaves that worker running in this workspace,
 * and "the budget is enforceable here" has to be true of the workspace, not of one call's delta.
 *
 * A member whose chain resolves to NOTHING (`provider: null`) is not refused here. That is an
 * unresolvable configuration, a different failure with its own wording at dispatch -- and since
 * no workspace that predates M12 has a `ProviderConfiguration` row, refusing it here would make
 * every such workspace unassignable.
 */
async function admitRoster(
  workspace: { readonly id: string; readonly budgetUsd: number | null; readonly archivedAt: Date | null },
  companyId: string,
): Promise<ControlRefusal | null> {
  if (workspace.budgetUsd === null) return null

  const workspaceDefault = await workspaceDefaultProvider(workspace.id)
  const members = await prisma.companySlave.findMany({
    where: { companyTeam: { companyId } },
    include: { template: true },
  })

  for (const member of members) {
    // A materialized worker starts with no override of its own, so the chain it resolves through
    // is its roster row, then its template, then the workspace default -- exactly what
    // `resolveRuntime` walks, called here rather than reimplemented so the write surface can
    // never admit a pair that dispatch would resolve differently.
    const resolved = resolveRuntime(
      { model: null, provider: null, companySlave: { model: member.model, provider: member.provider, template: member.template } },
      workspaceDefault,
    )
    if (resolved.provider === null) continue
    const verdict = admitProvider(workspace, resolved.provider)
    if (!verdict.ok) return verdict.refusal
  }

  return null
}

/** What {@link assignCompany} created -- the gate and M11's UI report this back to an operator. */
export interface AssignReport {
  readonly createdTeams: readonly string[]
  readonly createdWorkers: readonly { readonly companySlaveId: string; readonly name: string; readonly role: string }[]
}

/**
 * Assigns a company's roster to a project workspace (M10 §5): links `Workspace.companyId` and
 * materializes a project `Team`/`Slave` for every `CompanyTeam`/`CompanySlave` that has no
 * matching row there yet.
 *
 * Additive only (Decision 6): an existing project team or worker is never renamed, re-rowed, or
 * removed -- find-or-create by `companyTeamId` (teams, M11) and by `companySlaveId` (workers,
 * within the workspace, whichever department it was moved to) is the whole mechanism, so a re-run
 * against the same company is a no-op re-sync rather than a second copy. A team match falls back
 * to name once, ONLY against a legacy row with no
 * `companyTeamId` of its own: that row is adopted (stamped with the id, not renamed or re-rowed)
 * rather than duplicated, so a hand-made team from before M10 is linked exactly once and a
 * `CompanyTeam` rename afterward no longer produces a duplicate (M11) -- id, once stamped, always
 * wins over name.
 *
 * Assignment is one-way (Decision 2): once a workspace is linked to a company, assigning a
 * *different* company is refused rather than silently switching rosters out from under a running
 * project. Assigning the SAME company again is not a re-assignment at all -- it is the re-sync
 * path above, and always succeeds.
 *
 * The one-way check is re-run *inside* the transaction, behind a `SELECT ... FOR UPDATE` row lock
 * on the workspace, rather than trusted from a plain pre-check outside it -- `dependency.ts`'s own
 * doc comment names exactly why: Read Committed (Postgres's default, and this transaction names no
 * `isolationLevel`) does not make read-then-decide-then-write atomic against a second transaction
 * doing the same thing. Two operators racing to assign two *different* companies to the same
 * not-yet-assigned workspace would otherwise both observe `companyId === null` before either
 * commits, both pass an outside-only check, and both write -- the second silently overwriting the
 * first's `companyId`, which is exactly the one-way invariant this function exists to hold. The
 * lock makes the second transaction block until the first commits; when it resumes, its own
 * re-read sees the first transaction's now-committed `companyId` and correctly refuses instead of
 * overwriting it. See `dependency.ts:addTaskDependency` for the same idiom against the same class
 * of race.
 *
 * The roster read and every materializing write -- including the `companyId` write -- happen
 * inside that SAME transaction, `tx.slaveTemplate.findUniqueOrThrow` included: a template is
 * append-only in the ordinary path (Decision 9), so its being missing here is always a data
 * integrity failure, and letting that throw is what keeps a torn assignment (companyId written,
 * some workers created, others not) impossible. The event -- ALWAYS emitted, even with zero new
 * workers -- follows the transaction rather than living inside it, mirroring `setGoal`.
 */
export async function assignCompany(
  workspaceId: string,
  companyId: string,
  principal?: Principal,
): Promise<Result<AssignReport, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const company = await prisma.company.findUnique({ where: { id: companyId } })
  if (company === null) return err({ kind: 'company_not_found', companyId })

  const admission = await admitRoster(workspace, companyId)
  if (admission !== null) return err(admission)

  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ companyId: string | null }[]>`
      SELECT "companyId" FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE
    `
    const lockedCompanyId = locked[0]?.companyId ?? null
    if (lockedCompanyId !== null && lockedCompanyId !== companyId) {
      const current = await tx.company.findUniqueOrThrow({ where: { id: lockedCompanyId } })
      return {
        ok: false as const,
        error: { kind: 'company_already_assigned', workspaceId, companyName: current.name } as ControlRefusal,
      }
    }

    await tx.workspace.update({ where: { id: workspaceId }, data: { companyId } })

    const companyTeams = await tx.companyTeam.findMany({ where: { companyId }, include: { slaves: true } })

    const createdTeams: string[] = []
    const createdWorkers: { companySlaveId: string; name: string; role: string }[] = []

    for (const companyTeam of companyTeams) {
      let team = await tx.team.findFirst({ where: { workspaceId, companyTeamId: companyTeam.id } })
      if (team === null) {
        const legacy = await tx.team.findFirst({
          where: { workspaceId, name: companyTeam.name, companyTeamId: null },
        })
        team = legacy !== null
          ? await tx.team.update({ where: { id: legacy.id }, data: { companyTeamId: companyTeam.id } })
          : await tx.team.create({ data: { workspaceId, name: companyTeam.name, companyTeamId: companyTeam.id } })
        if (legacy === null) createdTeams.push(team.name)
      }

      for (const companySlave of companyTeam.slaves) {
        // Scoped to the WORKSPACE, not to this template's own copied department (M25 final
        // review, Critical): `moveSlave` keeps `companySlaveId` and only changes `teamId`, so a
        // worker moved to a different department of the same project is still this exact catalog
        // row's materialization -- looking it up by `{ teamId: team.id, companySlaveId }` would
        // miss it there and this loop would create a second `Slave` with the same name and the
        // same `companySlaveId` (there is no unique index on that column to catch it).
        const existingWorker = await tx.slave.findFirst({
          where: { companySlaveId: companySlave.id, team: { workspaceId } },
        })
        if (existingWorker !== null) continue

        const template = await tx.slaveTemplate.findUniqueOrThrow({ where: { id: companySlave.templateId } })
        const worker = await tx.slave.create({
          data: {
            teamId: team.id,
            name: companySlave.name,
            role: template.role,
            companySlaveId: companySlave.id,
          },
        })
        createdWorkers.push({ companySlaveId: companySlave.id, name: worker.name, role: worker.role })
      }
    }

    return { ok: true as const, value: { createdTeams, createdWorkers } }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'workspace.company_assigned',
    workspaceId,
    actor: 'human',
    payload: { company: company.name, workers: outcome.value.createdWorkers },
    userId: principal?.userId ?? null,
  })

  return ok(outcome.value)
}

/**
 * Sets or clears a worker's model+provider override (M10 §6, paired as of M12 Task 7) -- the top
 * of the resolution chain, above its roster row's override and its template's default. `model:
 * null, provider: null` clears both columns back to "defer to the roster/template", not a
 * refusal: an operator undoing an override is as ordinary as setting one. Setting only one half
 * of the pair is a refusal (`model_without_provider`) -- a model string means nothing without the
 * provider that runs it, and there is no such thing as "defer only the model, but pin the
 * provider" or vice versa.
 *
 * A single-row `updateMany` conditioned on `id`, not a `findUnique`-then-`update` pair: there is
 * nothing here for a second writer to race (unlike `assignCompany`'s multi-row materialization),
 * so the row lock ceremony that guards that transaction has no work to do in a two-column write --
 * the conditioned update's own count is already the atomic existence check, and both columns land
 * in the SAME statement so there is no window where one is written without the other.
 *
 * A READ now precedes that write, which the paragraph above deliberately said this function did
 * not need, so the reason is recorded rather than left as a contradiction. M12 Task 9 (spec §6,
 * ruling R6) makes this one of the two moments a provider can be bound to a budgeted workspace,
 * and the check needs the SLAVE'S WORKSPACE -- a fact `updateMany`'s `where: { id }` never had to
 * fetch. The read is unavoidable; what the earlier reasoning protects is the WRITE, and that is
 * unchanged: still one conditioned `updateMany`, still both columns in the same statement, still
 * no window in which a model exists without its provider. The read adds a check-then-write gap,
 * but nothing races it -- a budget cannot be changed by any verb in this codebase (see the
 * routing note below), and the same mismatch is re-checked at dispatch anyway.
 *
 * M23 D1 makes the read UNCONDITIONAL rather than only when `provider !== null`: `org.changed`'s
 * `from` is this slave's OLD model/provider pair, which only exists to read before the write
 * overwrites it, and the event needs `workspaceId` regardless of which direction (set or clear)
 * this call took. The same "nothing races it" reasoning still covers the wider read -- it is one
 * more fact pulled off the same row, not a new check-then-write gap of its own.
 *
 * Spec §6 also names a second write-time direction -- "setting a `budgetUsd` on a workspace
 * already resolved to one is refused". It has NO SITE: no verb in `packages/control`, no CLI
 * command and no route writes `Workspace.budgetUsd` anywhere in this tree; the column is set by
 * the schema default, by `packages/db`'s seed, and by test fixtures. Rather than invent a
 * `setBudget` verb nothing calls, that direction is routed forward with the create-workspace verb
 * the ledger already routed to Task 13/14, and this note is here so the gap is named rather than
 * silently missing.
 */
export async function setSlaveModel(
  slaveId: string,
  model: string | null,
  provider: ProviderKind | null,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (model !== null && model.trim() === '') return err({ kind: 'invalid_model' })
  if (provider !== null && !isProviderKind(provider)) return err({ kind: 'invalid_provider', provider })
  const pairErr = pairRefusal(model, provider)
  if (pairErr !== null) return err(pairErr)

  const slave = await prisma.slave.findUnique({
    where: { id: slaveId },
    select: {
      model: true,
      provider: true,
      team: { select: { workspaceId: true, workspace: { select: { id: true, budgetUsd: true, archivedAt: true } } } },
    },
  })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  if (provider !== null) {
    // Only when a provider is actually being PINNED. Clearing the pair (`null, null`) pins no
    // runtime at all -- it hands the choice back to the roster, the template and the workspace
    // default below it -- so there is nothing here to admit or refuse, and refusing an operator's
    // undo would trap them in the very override they are trying to remove.
    const verdict = admitProvider(slave.team.workspace, provider)
    if (!verdict.ok) return err(verdict.refusal)
  }

  const updated = await prisma.slave.updateMany({ where: { id: slaveId }, data: { model, provider } })
  if (updated.count === 0) return err({ kind: 'slave_not_found', slaveId })

  await appendEvent({
    type: 'org.changed',
    workspaceId: slave.team.workspaceId,
    slaveId,
    actor: 'human',
    payload: {
      entity: 'slave',
      id: slaveId,
      field: 'model',
      from: `${slave.model ?? '—'}@${slave.provider ?? '—'}`,
      to: `${model ?? '—'}@${provider ?? '—'}`,
    },
    userId: principal?.userId ?? null,
  })

  return ok(undefined)
}

// ---- D1: roster editing (M23 §5) ---------------------------------------------------------------
// `createTemplate`/`createCompany`/`addCompanyTeam`/`addCompanySlave`/`assignCompany` above only
// ever ADD to the catalog or the roster it materializes -- Decision 9 in M10's own comments made
// that append-only on purpose. The five verbs below are the first ones that EDIT a project team
// or slave already on a workspace's roster: rename, re-role, or remove it. Every one of them ends
// in exactly one `org.changed` event, `field` naming what moved -- the one new activity-log entry
// this task adds, so an operator can see a roster edit in the same timeline as everything else
// that happened to a workspace.
//
// `principal?: Principal` is accepted on all five (M23 F6): its `userId`, if any, rides the
// `org.changed` event each of them appends, the same as every other control verb.

/**
 * Locks and loads one `Slave` row for an editing verb, with exactly what every caller below
 * needs: its team (for the workspace id an `org.changed` event carries) and its runs (for the
 * live-run check `setSlaveRole` makes and the run count `deleteSlave` reports) -- one shared read
 * instead of five near-identical ones.
 *
 * `SELECT ... FOR UPDATE` first, not a plain `findUnique`: two operators editing the same slave
 * at once must serialise rather than race a lost update, the same `dependency.ts`/`world.ts`
 * idiom this package already uses for a single contested row.
 */
async function lockSlave(tx: Prisma.TransactionClient, slaveId: string) {
  await tx.$queryRaw`SELECT id FROM "Slave" WHERE id = ${slaveId} FOR UPDATE`
  return tx.slave.findUnique({
    where: { id: slaveId },
    include: {
      team: { select: { id: true, workspaceId: true } },
      runs: { select: { id: true, status: true } },
    },
  })
}

/** The same lock-then-load shape as {@link lockSlave}, for `renameTeam`/`deleteTeam`'s own row --
 *  its slaves are what `deleteTeam` counts and cascades into. */
async function lockTeam(tx: Prisma.TransactionClient, teamId: string) {
  await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${teamId} FOR UPDATE`
  return tx.team.findUnique({
    where: { id: teamId },
    include: { slaves: { select: { id: true } } },
  })
}

/**
 * Renames a project slave. Sibling names are unique per TEAM, matching `addCompanySlave`'s own
 * rule for the roster template this slave may have been instantiated from -- but there is no
 * unique index to lean on here (unlike that insert path): `Slave` carries no `@@unique([teamId,
 * name])`, so the check is a `findFirst` run inside the same locked transaction as the update,
 * not a caught constraint violation.
 */
export async function renameSlave(
  slaveId: string,
  name: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, slaveId)
    if (slave === null) return { ok: false as const, error: { kind: 'slave_not_found', slaveId } as ControlRefusal }

    const sibling = await tx.slave.findFirst({ where: { teamId: slave.teamId, name, NOT: { id: slaveId } } })
    if (sibling !== null) return { ok: false as const, error: { kind: 'duplicate_name', name } as ControlRefusal }

    await tx.slave.update({ where: { id: slaveId }, data: { name } })
    return { ok: true as const, value: { workspaceId: slave.team.workspaceId, from: slave.name } }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'org.changed',
    workspaceId: outcome.value.workspaceId,
    slaveId,
    actor: 'human',
    payload: { entity: 'slave', id: slaveId, field: 'name', from: outcome.value.from, to: name },
    userId: principal?.userId ?? null,
  })

  return ok(undefined)
}

/**
 * Changes a project slave's role -- the exact-match string the scheduler's `decide()` compares
 * against `Task.requiredRole`. Refused while the slave holds any run in a
 * `NON_TERMINAL_RUN_STATUSES` status: re-rolling a slave mid-dispatch would silently strand the
 * scheduler's decision, which was made against the role the run started with.
 */
export async function setSlaveRole(
  slaveId: string,
  role: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (role.trim() === '') return err({ kind: 'invalid_role' })

  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, slaveId)
    if (slave === null) return { ok: false as const, error: { kind: 'slave_not_found', slaveId } as ControlRefusal }

    const activeRun = slave.runs.find((run) => (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status))
    if (activeRun !== undefined) {
      return {
        ok: false as const,
        error: { kind: 'slave_run_active', slaveId, runId: activeRun.id } as ControlRefusal,
      }
    }

    await tx.slave.update({ where: { id: slaveId }, data: { role } })
    return { ok: true as const, value: { workspaceId: slave.team.workspaceId, from: slave.role } }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'org.changed',
    workspaceId: outcome.value.workspaceId,
    slaveId,
    actor: 'human',
    payload: { entity: 'slave', id: slaveId, field: 'role', from: outcome.value.from, to: role },
    userId: principal?.userId ?? null,
  })

  return ok(undefined)
}

/**
 * Removes a project slave WITH its run history; refused only while a run is live (M27 §4.1).
 * `Slave.runs` cascades on delete (schema.prisma) -- and everything under a run (`Checkpoint`),
 * plus `SlavePermission`, `SlaveSkill`, `SlaveMessage`. `ExecutionEvent.slaveId` has no FK and
 * keeps its value; the activity feed already renders past events from their payload and tolerates
 * a slave it can no longer resolve.
 */
export async function deleteSlave(
  slaveId: string,
  principal?: Principal,
): Promise<Result<{ readonly runs: number }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, slaveId)
    if (slave === null) return { ok: false as const, error: { kind: 'slave_not_found', slaveId } as ControlRefusal }

    const live = await liveRunCount(tx, { slaveId })
    if (live > 0) return { ok: false as const, error: { kind: 'live_runs', entity: 'slave', id: slaveId, runs: live } as ControlRefusal }
    const runs = slave.runs.length
    await tx.slave.delete({ where: { id: slaveId } })   // cascades SlaveRun (+Checkpoint), SlavePermission, SlaveSkill, SlaveMessage
    return { ok: true as const, value: { workspaceId: slave.team.workspaceId, from: slave.name, runs } }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'org.changed',
    workspaceId: outcome.value.workspaceId,
    slaveId,
    actor: 'human',
    payload: { entity: 'slave', id: slaveId, field: 'deleted', from: outcome.value.from, to: null, runs: outcome.value.runs },
    userId: principal?.userId ?? null,
  })

  return ok({ runs: outcome.value.runs })
}

/** Renames a project team. Sibling names are unique per WORKSPACE, the same rule
 *  {@link renameSlave} enforces per team -- and, as there, no unique index exists to lean on. */
export async function renameTeam(
  teamId: string,
  name: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  const outcome = await prisma.$transaction(async (tx) => {
    const team = await lockTeam(tx, teamId)
    if (team === null) return { ok: false as const, error: { kind: 'team_not_found', teamId } as ControlRefusal }

    const sibling = await tx.team.findFirst({ where: { workspaceId: team.workspaceId, name, NOT: { id: teamId } } })
    if (sibling !== null) return { ok: false as const, error: { kind: 'duplicate_name', name } as ControlRefusal }

    await tx.team.update({ where: { id: teamId }, data: { name } })
    return { ok: true as const, value: { workspaceId: team.workspaceId, from: team.name } }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'org.changed',
    workspaceId: outcome.value.workspaceId,
    actor: 'human',
    payload: { entity: 'team', id: teamId, field: 'name', from: outcome.value.from, to: name },
    userId: principal?.userId ?? null,
  })

  return ok(undefined)
}

/**
 * Removes a project team WITH its slaves and everything under them; refused only while any slave
 * of the department holds a live run (M27 §4.2).
 *
 * `lockTeam`'s `FOR UPDATE` on the `Team` row alone is not enough (fix round 1, controller ruling
 * R11): it blocks a concurrent `Slave` insert into this team (an insert takes `FOR KEY SHARE` on
 * the `Team` row it references), but a `SlaveRun` insert against a slave THIS team already has
 * takes `FOR KEY SHARE` on that `Slave` row, not `Team` -- untouched by `lockTeam`. Without also
 * locking every `Slave` row of this team, the scheduler could start a run between the live-run
 * count below and the delete, which the cascade would then silently take down along with its slave.
 * `SELECT ... FOR UPDATE` on the slave rows closes that window the same way `lockTeam`/`lockSlave`
 * close it for their own row.
 */
export async function deleteTeam(
  teamId: string,
  principal?: Principal,
): Promise<Result<{ readonly slaves: number; readonly runs: number }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    const team = await lockTeam(tx, teamId)
    if (team === null) return { ok: false as const, error: { kind: 'team_not_found', teamId } as ControlRefusal }
    await tx.$queryRaw`SELECT id FROM "Slave" WHERE "teamId" = ${teamId} FOR UPDATE`

    const live = await liveRunCount(tx, { teamId })
    if (live > 0) return { ok: false as const, error: { kind: 'live_runs', entity: 'team', id: teamId, runs: live } as ControlRefusal }
    const slaves = team.slaves.length
    const runs = await tx.slaveRun.count({ where: { slave: { teamId } } })
    await tx.team.delete({ where: { id: teamId } })   // cascades Slave and everything under it
    return { ok: true as const, value: { workspaceId: team.workspaceId, from: team.name, slaves, runs } }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'org.changed',
    workspaceId: outcome.value.workspaceId,
    actor: 'human',
    payload: { entity: 'team', id: teamId, field: 'deleted', from: outcome.value.from, to: null, slaves: outcome.value.slaves, runs: outcome.value.runs },
    userId: principal?.userId ?? null,
  })

  return ok({ slaves: outcome.value.slaves, runs: outcome.value.runs })
}

// ---- M25 §3.1: departments -----------------------------------------------------------------
// A "department" is a project `Team`; a "department template" is a catalog `CompanyTeam`. The two
// project-level verbs below emit `org.changed` like `renameTeam`; the three catalog-level verbs
// emit nothing, the rule `addCompanyTeam`/`addCompanySlave` already follow (no workspace, no
// event).

/** Creates a department in a project with no template link (`companyTeamId: null`). Names are
 *  unique per workspace, the rule {@link renameTeam} enforces -- and, as there, there is no
 *  unique index to lean on, so the check runs inside the transaction. */
export async function createProjectTeam(
  workspaceId: string,
  name: string,
  principal?: Principal,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  const outcome = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
    if (workspace === null) return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId } as ControlRefusal }

    const sibling = await tx.team.findFirst({ where: { workspaceId, name } })
    if (sibling !== null) return { ok: false as const, error: { kind: 'duplicate_name', name } as ControlRefusal }

    const team = await tx.team.create({ data: { workspaceId, name, companyTeamId: null } })
    return { ok: true as const, value: { id: team.id } }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'org.changed',
    workspaceId,
    actor: 'human',
    payload: { entity: 'team', id: outcome.value.id, field: 'created', from: null, to: name },
    userId: principal?.userId ?? null,
  })

  return ok({ id: outcome.value.id })
}

/**
 * Moves a project slave to another department of the SAME project. `companySlaveId` is left
 * alone: the slave still knows which catalog row it came from, only its department changed, and
 * `assignCompany` run again later finds it by that id anywhere in the project and leaves it where
 * it is (M25 final review corrected that lookup, which used to be scoped to the template's own
 * department -- §12 entry 13). Refused while the slave holds a live run, the rule
 * {@link setSlaveRole} applies -- and, as of the same review, while the target department already
 * has a slave of that name, the rule {@link renameSlave} applies (M25 final review, Important:
 * `moveSlave` was the one write path that skipped the per-department unique-name rule every
 * sibling verb enforces). A move to the slave's CURRENT department is a no-op: nothing changes,
 * so there is nothing to check the name clash against and nothing worth an `org.changed` event
 * over -- the transaction returns `value: null` for that case and the event below is skipped.
 */
export async function moveSlave(
  slaveId: string,
  teamId: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, slaveId)
    if (slave === null) return { ok: false as const, error: { kind: 'slave_not_found', slaveId } as ControlRefusal }

    // Copy `setSlaveRole`'s live-run check here verbatim (the `slave_run_active` refusal keyed on
    // `NON_TERMINAL_RUN_STATUSES`), so both verbs refuse on the same definition of "live".
    const live = slave.runs.find((run) => (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status))
    if (live !== undefined) {
      return { ok: false as const, error: { kind: 'slave_run_active', slaveId, runId: live.id } as ControlRefusal }
    }

    const target = await tx.team.findUnique({ where: { id: teamId }, select: { id: true, name: true, workspaceId: true } })
    if (target === null) return { ok: false as const, error: { kind: 'team_not_found', teamId } as ControlRefusal }
    if (target.workspaceId !== slave.team.workspaceId) {
      return { ok: false as const, error: { kind: 'team_workspace_mismatch', slaveId, teamId } as ControlRefusal }
    }

    if (slave.team.id === teamId) return { ok: true as const, value: null }

    const clash = await tx.slave.findFirst({ where: { teamId, name: slave.name, NOT: { id: slaveId } } })
    if (clash !== null) return { ok: false as const, error: { kind: 'duplicate_name', name: slave.name } as ControlRefusal }

    const from = await tx.team.findUniqueOrThrow({ where: { id: slave.team.id }, select: { name: true } })
    await tx.slave.update({ where: { id: slaveId }, data: { teamId } })
    return { ok: true as const, value: { workspaceId: target.workspaceId, from: from.name, to: target.name } }
  })

  if (!outcome.ok) return err(outcome.error)

  if (outcome.value !== null) {
    await appendEvent({
      type: 'org.changed',
      workspaceId: outcome.value.workspaceId,
      slaveId,
      actor: 'human',
      payload: { entity: 'slave', id: slaveId, field: 'team', from: outcome.value.from, to: outcome.value.to },
      userId: principal?.userId ?? null,
    })
  }

  return ok(undefined)
}

/** Moves a catalog slave to another department template of the SAME company. The unique index
 *  `@@unique([companyTeamId, name])` is what refuses a name clash, caught the way
 *  {@link addCompanySlave} catches it. No event: the catalog has no workspace. */
export async function moveCompanySlave(
  companySlaveId: string,
  companyTeamId: string,
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const slave = await prisma.companySlave.findUnique({
    where: { id: companySlaveId },
    select: { id: true, name: true, companyTeam: { select: { companyId: true } } },
  })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId: companySlaveId })

  const target = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { id: true, companyId: true } })
  if (target === null) return err({ kind: 'company_team_not_found', companyTeamId })
  if (target.companyId !== slave.companyTeam.companyId) return err({ kind: 'company_mismatch', companySlaveId, companyTeamId })

  try {
    await prisma.companySlave.update({ where: { id: companySlaveId }, data: { companyTeamId } })
    return ok(undefined)
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name: slave.name })
    throw error
  }
}

/** Renames a department template. `@@unique([companyId, name])` refuses a sibling clash. No event. */
export async function renameCompanyTeam(
  companyTeamId: string,
  name: string,
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  const team = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { id: true } })
  if (team === null) return err({ kind: 'company_team_not_found', companyTeamId })

  try {
    await prisma.companyTeam.update({ where: { id: companyTeamId }, data: { name } })
    return ok(undefined)
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/**
 * Deletes a department template WITH its catalog slaves; project departments copied from it
 * survive (`onDelete: SetNull` on `Team.companyTeam`). No event.
 *
 * Locked check-then-delete, the same shape as {@link deleteTeam}: `SELECT ... FOR UPDATE` first
 * serialises against a concurrent `addCompanySlave`/`moveCompanySlave` into this template, the same
 * `lockTeam` idiom.
 */
export async function deleteCompanyTeam(
  companyTeamId: string,
  _principal?: Principal,
): Promise<Result<{ readonly catalogSlaves: number }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "CompanyTeam" WHERE id = ${companyTeamId} FOR UPDATE`
    const team = await tx.companyTeam.findUnique({
      where: { id: companyTeamId },
      select: { id: true, _count: { select: { slaves: true } } },
    })
    if (team === null) return { ok: false as const, error: { kind: 'company_team_not_found', companyTeamId } as ControlRefusal }
    const catalogSlaves = team._count.slaves

    await tx.companyTeam.delete({ where: { id: companyTeamId } })
    return { ok: true as const, value: { catalogSlaves } }
  })

  return outcome.ok ? ok(outcome.value) : err(outcome.error)
}

/**
 * Removes a catalog slave (M27 §5). The project slaves materialized from it survive with
 * `companySlaveId` null (`SetNull`). No event: the catalog has no workspace.
 *
 * Locked check-then-delete, the same shape as {@link deleteSlaveTemplate} and {@link deleteCompany}
 * below (spec §5: every catalog verb locks the row it deletes).
 */
export async function deleteCompanySlave(
  companySlaveId: string,
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "CompanySlave" WHERE id = ${companySlaveId} FOR UPDATE`
    const row = await tx.companySlave.findUnique({ where: { id: companySlaveId }, select: { id: true } })
    if (row === null) return { ok: false as const, error: { kind: 'company_slave_not_found', companySlaveId } as ControlRefusal }
    await tx.companySlave.delete({ where: { id: companySlaveId } })
    return { ok: true as const, value: undefined }
  })
  return outcome.ok ? ok(undefined) : err(outcome.error)
}

/**
 * Removes a slave template WITH the catalog slaves instantiated from it (M27 §5): the schema says
 * nothing about `CompanySlave.template` (Restrict), so the verb deletes them first, in the same
 * transaction behind a row lock. Project slaves keep the role that was copied at
 * materialization. No event.
 */
export async function deleteSlaveTemplate(
  templateId: string,
  _principal?: Principal,
): Promise<Result<{ readonly catalogSlaves: number }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SlaveTemplate" WHERE id = ${templateId} FOR UPDATE`
    const row = await tx.slaveTemplate.findUnique({ where: { id: templateId }, select: { id: true } })
    if (row === null) return { ok: false as const, error: { kind: 'template_not_found', templateId } as ControlRefusal }
    const { count: catalogSlaves } = await tx.companySlave.deleteMany({ where: { templateId } })
    await tx.slaveTemplate.delete({ where: { id: templateId } })
    return { ok: true as const, value: { catalogSlaves } }
  })
  return outcome.ok ? ok(outcome.value) : err(outcome.error)
}

/**
 * Removes a company WITH its department templates and catalog slaves (the schema cascades both).
 * `Workspace.companyId` is an optional FK with no explicit `onDelete`, which Prisma emits as
 * `ON DELETE SET NULL` -- the database would clear it on its own -- but the verb detaches assigned
 * projects itself first, with an explicit `updateMany`, so it can COUNT what was detached
 * (`projectsDetached`) before the row is gone. Every department and slave those projects copied
 * survives. No event.
 */
export async function deleteCompany(
  companyId: string,
  _principal?: Principal,
): Promise<Result<{ readonly templates: number; readonly catalogSlaves: number; readonly projectsDetached: number }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`
    const row = await tx.company.findUnique({ where: { id: companyId }, select: { id: true, _count: { select: { teams: true } } } })
    if (row === null) return { ok: false as const, error: { kind: 'company_not_found', companyId } as ControlRefusal }
    const catalogSlaves = await tx.companySlave.count({ where: { companyTeam: { companyId } } })
    const { count: projectsDetached } = await tx.workspace.updateMany({ where: { companyId }, data: { companyId: null } })
    await tx.company.delete({ where: { id: companyId } })
    return { ok: true as const, value: { templates: row._count.teams, catalogSlaves, projectsDetached } }
  })
  return outcome.ok ? ok(outcome.value) : err(outcome.error)
}
