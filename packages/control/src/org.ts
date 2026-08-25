import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import type { ProviderKind } from '@ai-team-os/providers'
import type { ControlRefusal } from './refusal.js'

/**
 * `true` for Prisma's unique-constraint violation (P2002), the error every `create` below can
 * throw when it collides with a `@unique`/`@@unique` index. Checked by shape rather than
 * `instanceof PrismaClientKnownRequestError` -- the class is a runtime value the generated client
 * does not currently re-export from `@ai-team-os/db/client` -- and caught rather than
 * pre-queried: a pre-query-then-insert has a race between the two steps that the DB constraint
 * itself cannot have.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

/**
 * Every member of `ProviderKind` (M12 Task 7), as data. `@ai-team-os/providers` types the kind as
 * a plain string union -- see that package's `types.ts` docstring for why it does not import the
 * generated Prisma enum -- so there is no runtime value to check an untrusted string against
 * without this list living somewhere. It lives here rather than in `@ai-team-os/providers`
 * because the only caller that needs to validate an UNTRUSTED provider string (a CLI flag, a web
 * request body) is this module's own write surface; nothing downstream resolves or dispatches on
 * it (Task 8's job).
 */
const PROVIDER_KINDS = ['claude_code', 'cursor'] as const satisfies readonly ProviderKind[]

// Compile-time completeness check, mirroring `packages/db/src/enums.ts`'s own `AssertNever`
// idiom: `satisfies` above proves every element of `PROVIDER_KINDS` is a `ProviderKind`
// (soundness); this proves the reverse -- every `ProviderKind` is in `PROVIDER_KINDS`
// (completeness) -- so a third provider kind added to the type without a matching entry here
// fails the build instead of silently validating as "unknown".
type _AssertNever<T extends never> = T
type _ProviderKindsComplete = _AssertNever<Exclude<ProviderKind, (typeof PROVIDER_KINDS)[number]>>

function isProviderKind(value: string): value is ProviderKind {
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
 * Adds a reusable agent template to the catalog (M10 §4) -- the definition `addCompanyAgent`
 * below instantiates onto a company's roster. Templates are append-only (Decision 9): there is no
 * update or delete here, only creation.
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
    const template = await prisma.agentTemplate.create({
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
 * from a template. Agent names are unique per team, not globally: the same name in two different
 * teams (even in the same company) is unrelated identities and is allowed.
 */
export async function addCompanyAgent(
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

  const template = await prisma.agentTemplate.findUnique({ where: { id: templateId }, select: { id: true } })
  if (template === null) return err({ kind: 'template_not_found', templateId })

  try {
    const agent = await prisma.companyAgent.create({
      data: {
        companyTeamId,
        templateId,
        name,
        ...(options?.model !== undefined ? { model: options.model } : {}),
        ...(options?.provider !== undefined ? { provider: options.provider } : {}),
      },
    })
    return ok({ id: agent.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/** What {@link assignCompany} created -- the gate and M11's UI report this back to an operator. */
export interface AssignReport {
  readonly createdTeams: readonly string[]
  readonly createdWorkers: readonly { readonly companyAgentId: string; readonly name: string; readonly role: string }[]
}

/**
 * Assigns a company's roster to a project workspace (M10 §5): links `Workspace.companyId` and
 * materializes a project `Team`/`Agent` for every `CompanyTeam`/`CompanyAgent` that has no
 * matching row there yet.
 *
 * Additive only (Decision 6): an existing project team or worker is never renamed, re-rowed, or
 * removed -- find-or-create by `companyTeamId` (teams, M11) and by `companyAgentId` (workers) is
 * the whole mechanism, so a re-run against the same company is a no-op re-sync rather than a
 * second copy. A team match falls back to name once, ONLY against a legacy row with no
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
 * inside that SAME transaction, `tx.agentTemplate.findUniqueOrThrow` included: a template is
 * append-only in the ordinary path (Decision 9), so its being missing here is always a data
 * integrity failure, and letting that throw is what keeps a torn assignment (companyId written,
 * some workers created, others not) impossible. The event -- ALWAYS emitted, even with zero new
 * workers -- follows the transaction rather than living inside it, mirroring `setGoal`.
 */
export async function assignCompany(
  workspaceId: string,
  companyId: string,
): Promise<Result<AssignReport, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const company = await prisma.company.findUnique({ where: { id: companyId } })
  if (company === null) return err({ kind: 'company_not_found', companyId })

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

    const companyTeams = await tx.companyTeam.findMany({ where: { companyId }, include: { agents: true } })

    const createdTeams: string[] = []
    const createdWorkers: { companyAgentId: string; name: string; role: string }[] = []

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

      for (const companyAgent of companyTeam.agents) {
        const existingWorker = await tx.agent.findFirst({
          where: { teamId: team.id, companyAgentId: companyAgent.id },
        })
        if (existingWorker !== null) continue

        const template = await tx.agentTemplate.findUniqueOrThrow({ where: { id: companyAgent.templateId } })
        const worker = await tx.agent.create({
          data: {
            teamId: team.id,
            name: companyAgent.name,
            role: template.role,
            companyAgentId: companyAgent.id,
          },
        })
        createdWorkers.push({ companyAgentId: companyAgent.id, name: worker.name, role: worker.role })
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
 */
export async function setAgentModel(
  agentId: string,
  model: string | null,
  provider: ProviderKind | null,
): Promise<Result<void, ControlRefusal>> {
  if (model !== null && model.trim() === '') return err({ kind: 'invalid_model' })
  if (provider !== null && !isProviderKind(provider)) return err({ kind: 'invalid_provider', provider })
  const pairErr = pairRefusal(model, provider)
  if (pairErr !== null) return err(pairErr)

  const updated = await prisma.agent.updateMany({ where: { id: agentId }, data: { model, provider } })
  if (updated.count === 0) return err({ kind: 'agent_not_found', agentId })
  return ok(undefined)
}
