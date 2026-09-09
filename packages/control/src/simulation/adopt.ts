import { prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { admitRoster, AssignmentRefused, assignCompanyTx, type AssignReport } from '../org.js'
import type { Principal } from '../principal.js'
import type { ControlRefusal } from '../refusal.js'
import { loadSimulation, rosterOf } from './read.js'
import { json, locked, namespacedKey, type LoadedDefinition, type LoadedSimulation } from './shared.js'
import { watermark } from './write.js'

/**
 * What a person sees before they adopt (M33 §3): who ends up with which role, what settings the
 * run's policy proposes, which model an `llm` run would put on the lead, and which projects are
 * even eligible. Nothing here is written -- this is the drawer's whole read.
 */
export interface AdoptionPreview {
  readonly simulationId: string
  readonly companyId: string
  readonly companyName: string
  /** One row per CURRENT roster member, in the same order `createSimulation` reads a roster
   *  (department by name, member by name). `role` is the run's OWN word for what it gave this
   *  member to do -- its role name or an engineer's expertise -- and `catalogRole` the template
   *  role it displaces; a member the run never named carries the same string in both. `runtimeRole`
   *  is what adoption actually WRITES to `Slave.role` (R2, `roleOverridesOf`): the translated
   *  `lead`/`reviewer`, or `catalogRole` for everyone else -- fix round 1, so the drawer's table
   *  reads it off control rather than re-deriving the same two-entry translation itself. */
  readonly roles: readonly { readonly slaveName: string; readonly catalogRole: string; readonly role: string; readonly runtimeRole: string }[]
  /** {@link leadNameOf}: the roster row `applyModel` may write, or `null` for a run with no `lead`
   *  role. Published so the drawer reads it off control rather than finding the row itself with a
   *  `roles.find((row) => row.role === 'lead')` lookup of its own (M34 t3). */
  readonly leadName: string | null
  /** `autoMerge` is `false` and stays `false` (§1 principle 3): adoption never switches on a merge
   *  a person did not ask for, so the type says so rather than the drawer remembering to. */
  readonly settings: { readonly maxConcurrentRuns: number; readonly maxAttempts: number; readonly autoMerge: false }
  readonly model: { readonly provider: 'claude_code' | 'cursor'; readonly model: string } | null
  /** Every project with no company and no archive date, by name. Adoption's only legal targets. */
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
}

/** The settings a person may bend, and the ranges the workspace columns actually mean anything
 *  in. `maxAttempts` tops out at 5 because a task that has failed five times is not going to pass
 *  on the sixth; `maxConcurrentRuns` at 10 because that is the scheduler's own working range. */
const MAX_CONCURRENT_RUNS_RANGE = { min: 1, max: 10 } as const
const MAX_ATTEMPTS_RANGE = { min: 1, max: 5 } as const

function rangeRefusal(name: string, value: number | undefined, range: { readonly min: number; readonly max: number }): ControlRefusal | null {
  if (value === undefined) return null
  if (Number.isInteger(value) && value >= range.min && value <= range.max) return null
  return { kind: 'invalid_simulation_input', detail: `${name} must be an integer between ${range.min} and ${range.max}` }
}

const clamp = (value: number, range: { readonly min: number; readonly max: number }): number =>
  Math.min(range.max, Math.max(range.min, value))

/** The engineer pool as the software definition writes it. Read defensively rather than through
 *  the sector's own schema: control never imports a sector's types (M31b §1 principle 1), and the
 *  ONLY runs that reach here are ones their own plugin called adoptable. */
function engineersOf(definition: LoadedDefinition): readonly { readonly id: string; readonly expertise: string }[] {
  const raw = definition['engineers']
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const { id, expertise } = entry as { id?: unknown; expertise?: unknown }
    return typeof id === 'string' && typeof expertise === 'string' ? [{ id, expertise }] : []
  })
}

/**
 * `slaveName → role` for every member the RUN gave a job to (§3): its decision roles by name
 * (`product`, `lead`, `reviewer`) and its engineers by expertise (`backend`, `general`, …). This
 * is the run's OWN vocabulary, and it is what the preview shows and the `adopted` journal row
 * records -- not what gets written to a `Slave` (see {@link roleOverridesOf}).
 */
function runRolesOf(definition: LoadedDefinition): Readonly<Record<string, string>> {
  const roles: Record<string, string> = {}
  for (const role of definition.roles) roles[role.slaveName] = role.name
  for (const engineer of engineersOf(definition)) roles[engineer.id] = engineer.expertise
  return roles
}

/**
 * The run's decision roles in the RUNTIME's vocabulary (controller ruling R2). A materialised
 * worker's role is not just a label: the scheduler matches `Task.requiredRole` against its
 * `runtimeRoles`, `planning.ts` staffs `'manager' ∈ runtimeRoles` and `review.ts` staffs
 * `'reviewer' ∈ runtimeRoles` -- so a worker materialised as `'lead'` would be a manager no
 * planning pass could find. Adoption therefore TRANSLATES rather than copies.
 *
 * The translation is what this table names; `assignCompanyTx` writes it into BOTH columns (M37
 * t3): `role` as the worker's title, and `runtimeRoles` as `[translated, catalog]` deduped, so a
 * translated worker stays dispatchable as the catalog role the planner emits too.
 *
 * Only two entries have a translation. `product` has no runtime counterpart, and an engineer's
 * expertise (`backend`, `general`) is not a role at all -- the planner emits CATALOG roles as a
 * task's `requiredRole`, so those members must keep the catalog role they would have been
 * materialised with anyway. The run's full assignment is not lost: it is in the preview and in the
 * journal.
 */
const RUNTIME_ROLE: Readonly<Record<string, string>> = { lead: 'manager', reviewer: 'reviewer' }

/** The preview's reading of {@link RUNTIME_ROLE}: a `lead`/`reviewer` translates, everyone else
 *  keeps the catalog role they would be materialised with anyway. {@link roleOverridesOf} reads the
 *  same one table (it emits an entry only where the table has one), so the two cannot drift on
 *  what translates to what (fix round 1, ruling R3). */
function runtimeRoleOf(role: string, catalogRole: string): string {
  return RUNTIME_ROLE[role] ?? catalogRole
}

/** The `slaveName → role` map `assignCompanyTx` actually writes: the translated decision roles and
 *  nothing else. A roster member with no entry here is materialised with the catalog role, exactly
 *  as a hand assignment does. */
function roleOverridesOf(definition: LoadedDefinition): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {}
  for (const role of definition.roles) {
    const runtime = RUNTIME_ROLE[role.name]
    if (runtime !== undefined) overrides[role.slaveName] = runtime
  }
  return overrides
}

/** The proposal §3 derives from the frozen definition: as many concurrent runs as the run had
 *  engineers, and the careful policy's two attempts against the fast one's three. */
function proposedSettings(definition: LoadedDefinition): { readonly maxConcurrentRuns: number; readonly maxAttempts: number; readonly autoMerge: false } {
  return {
    maxConcurrentRuns: clamp(engineersOf(definition).length, MAX_CONCURRENT_RUNS_RANGE),
    maxAttempts: definition.policy === 'B' ? 2 : 3,
    autoMerge: false,
  }
}

/** The run's model as a roster override would carry it -- both columns or neither (the pair rule,
 *  M12 Task 7). Null for a `rules` run, which never chose one. */
function modelOf(summary: LoadedSimulation['summary']): { readonly provider: 'claude_code' | 'cursor'; readonly model: string } | null {
  if (summary.decisionProvider !== 'llm' || summary.modelProvider === null || summary.model === null) return null
  return { provider: summary.modelProvider, model: summary.model }
}

/** The lead's slave name, which is the ONE roster row `applyModel` may write (§3). */
function leadNameOf(definition: LoadedDefinition): string | null {
  return definition.roles.find((role) => role.name === 'lead')?.slaveName ?? null
}

/** §1 principle 5, asked of the sector rather than answered by control: only a plugin knows
 *  whether its own roles are roles a coding project can be run by, and its refusal carries the
 *  sentence a person reads. */
function adoptableRefusal(loaded: LoadedSimulation): ControlRefusal | null {
  const verdict = loaded.plugin.adoptable
  return verdict.ok ? null : { kind: 'not_adoptable', simulationId: loaded.summary.id, reason: verdict.reason }
}

export async function adoptionPreview(simulationId: string): Promise<Result<AdoptionPreview, ControlRefusal>> {
  const loaded = await loadSimulation(simulationId)
  if (!loaded.ok) return loaded
  const refusal = adoptableRefusal(loaded.value)
  if (refusal !== null) return err(refusal)
  const { summary, definition } = loaded.value

  // The CURRENT roster, read exactly as `createSimulation` read it -- so the preview shows what
  // `assignCompanyTx` would actually materialise today, roster edits since the run included,
  // rather than the frozen list the run was created from.
  const company = await prisma.company.findUnique({
    where: { id: summary.companyId },
    select: { name: true, teams: { orderBy: { name: 'asc' }, select: { name: true, slaves: { orderBy: { name: 'asc' }, select: { name: true, template: { select: { role: true } } } } } } },
  })
  if (company === null) return err({ kind: 'company_not_found', companyId: summary.companyId })

  // The RUN's own roles, not the translated ones (R2): the preview is where a person sees who the
  // simulation made its lead, its reviewer and its backend engineer.
  const runRoles = runRolesOf(definition)
  const workspaces = await prisma.workspace.findMany({
    where: { companyId: null, archivedAt: null },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })

  return ok({
    simulationId,
    companyId: summary.companyId,
    companyName: company.name,
    roles: rosterOf(company.teams).map((member) => {
      const role = runRoles[member.slaveName] ?? member.role
      return { slaveName: member.slaveName, catalogRole: member.role, role, runtimeRole: runtimeRoleOf(role, member.role) }
    }),
    leadName: leadNameOf(definition),
    settings: proposedSettings(definition),
    model: modelOf(summary),
    workspaces,
  })
}

/** Thrown to roll a half-written adoption back: a `$transaction` callback that RETURNS a refusal
 *  commits everything written before it, which is exactly what this must not do. Caught by
 *  {@link adoptSimulation} and unwrapped into the refusal it carries.
 *
 *  Every explicit `throw new AdoptionRefused(...)` SITE in this file's own transaction body is
 *  DEFENSIVE and, as the code stands, unreachable: each is decided before this function's own
 *  first write. `assignCompanyTx`'s own `company_already_assigned` is precluded by the stricter
 *  "any company at all" guard a few lines above it, under the same workspace lock, and the model's
 *  ambiguity refusal was hoisted above the assignment for the same reason. That is a property of
 *  today's ordering, not a guarantee -- a future refusal added after the assignment would silently
 *  commit a half-adopted project without this, which is why the throw stays.
 *
 *  `assignCompanyTx`'s OWN post-write refusal (M34 t2 fix round 2, `Team_workspaceId_name_key`) is
 *  NOT one of these unreachable sites: it throws {@link AssignmentRefused} directly from inside
 *  `assignCompanyTx` -- a different class, defined in `org.ts` for `assignCompany`'s own use too --
 *  and this file's outer `catch` converts that one into an `AdoptionRefused`-shaped `Result` at
 *  the same place it already unwraps this class, rather than adding a second unwrapping site. */
class AdoptionRefused extends Error {
  constructor(readonly refusal: ControlRefusal) {
    super('adoption refused')
    this.name = 'AdoptionRefused'
  }
}

/**
 * Puts an organisation tried in a simulation onto a real project (M33 §3): the roster materialised
 * with the roles the run assigned, the settings its policy proposes, an optional model override on
 * the lead, and provenance on both sides. Starts NOTHING -- no daemon, no run, no deploy (§1
 * principle 3) -- and `autoMerge` lands `false` whatever the workspace carried before.
 *
 * The whole write is one transaction so a refusal cannot leave a project half-adopted: the run row
 * is locked `FOR UPDATE` first (the journal seq and the watermark are read under it),
 * `assignCompanyTx` takes the workspace's own lock second, and any refusal after the assignment is
 * thrown rather than returned so Prisma rolls the materialised roster back with it.
 *
 * The provider admission (`admitRoster`) runs BEFORE the transaction opens, exactly where
 * `assignCompany` runs it: it is a read across the roster's resolution chains, not a write, and
 * holding two row locks across it would buy nothing.
 */
export async function adoptSimulation(
  simulationId: string,
  input: {
    readonly workspaceId: string
    readonly maxConcurrentRuns?: number
    readonly maxAttempts?: number
    readonly applyModel?: boolean
    readonly idempotencyKey?: string
  },
  principal?: Principal,
): Promise<Result<{ readonly workspaceId: string; readonly assigned: AssignReport }, ControlRefusal>> {
  const invalid =
    rangeRefusal('maxConcurrentRuns', input.maxConcurrentRuns, MAX_CONCURRENT_RUNS_RANGE) ??
    rangeRefusal('maxAttempts', input.maxAttempts, MAX_ATTEMPTS_RANGE)
  if (invalid !== null) return err(invalid)

  const preloaded = await loadSimulation(simulationId)
  if (!preloaded.ok) return preloaded
  const notAdoptable = adoptableRefusal(preloaded.value)
  if (notAdoptable !== null) return err(notAdoptable)
  const companyId = preloaded.value.summary.companyId

  const workspace = await prisma.workspace.findUnique({ where: { id: input.workspaceId } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId: input.workspaceId })
  if (workspace.archivedAt !== null) return err({ kind: 'workspace_archived', workspaceId: input.workspaceId })

  const admission = await admitRoster(workspace, companyId)
  if (admission !== null) return err(admission)

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const got = await locked(tx, simulationId)
      if (!got.ok) throw new AdoptionRefused(got.error)
      const { row, loaded } = got.value
      const stillNotAdoptable = adoptableRefusal(loaded)
      if (stillNotAdoptable !== null) throw new AdoptionRefused(stillNotAdoptable)

      // Replay before anything is read further, the same rule `stepSimulation` follows: a repeated
      // key returns the FIRST call's outcome rather than refusing `company_already_assigned` for
      // the assignment it itself made. A replay materialises nothing, which is exactly what
      // `assignCompany`'s own re-sync path reports for an already-materialised roster.
      if (input.idempotencyKey !== undefined) {
        const seen = await tx.simulationJournalEntry.findUnique({
          where: { simulationId_idempotencyKey: { simulationId, idempotencyKey: namespacedKey('adopt', input.idempotencyKey) } },
        })
        if (seen !== null) {
          const payload = seen.payload as { workspaceId?: string }
          // A key identifies ONE adoption, not one caller (review round 1): replaying it against a
          // different project would report the first project's id as though the second had been
          // adopted. Refused rather than silently answered for the wrong workspace.
          if (payload.workspaceId !== undefined && payload.workspaceId !== input.workspaceId) {
            throw new AdoptionRefused({ kind: 'invalid_simulation_input', detail: 'idempotency key already used for another workspace' })
          }
          return { replayed: true as const, workspaceId: payload.workspaceId ?? input.workspaceId, assigned: { createdTeams: [], createdWorkers: [] } satisfies AssignReport }
        }
      }

      // Re-read behind the workspace's OWN `FOR UPDATE` lock -- the same lock `assignCompanyTx`
      // takes a few lines below, taken here first so all three of these checks are decided against
      // a row no concurrent assignment can move underneath them.
      const targets = await tx.$queryRaw<{ id: string; name: string; archivedAt: Date | null; companyId: string | null }[]>`
        SELECT id, name, "archivedAt", "companyId" FROM "Workspace" WHERE id = ${input.workspaceId} FOR UPDATE
      `
      const target = targets[0]
      if (target === undefined) throw new AdoptionRefused({ kind: 'workspace_not_found', workspaceId: input.workspaceId })
      if (target.archivedAt !== null) throw new AdoptionRefused({ kind: 'workspace_archived', workspaceId: input.workspaceId })
      // §6 non-goal: adoption targets a project that has NO company. `assignCompanyTx`'s one-way
      // rule only refuses a DIFFERENT company -- re-assigning the same one is its ordinary re-sync
      // path -- so a second run of the same company would otherwise quietly overwrite the first
      // adoption's settings and provenance. Asked here, the refusal is the same one either way.
      if (target.companyId !== null) {
        const current = await tx.company.findUniqueOrThrow({ where: { id: target.companyId }, select: { name: true } })
        throw new AdoptionRefused({ kind: 'company_already_assigned', workspaceId: input.workspaceId, companyName: current.name })
      }

      // Paid use stays an explicit choice (§1 principle 4): only with `applyModel`, only from an
      // `llm` run, and only onto the lead's OWN roster row. Resolved to ONE row here, before
      // anything is written (review round 1): `CompanySlave` is unique on `(companyTeamId, name)`,
      // not on `(companyId, name)`, so a company with an "Atlas" in two departments has two rows a
      // name-scoped update would both have written -- one of them a roster row nobody chose to
      // spend money on. Ambiguity is refused, never guessed.
      const model = modelOf(loaded.summary)
      const leadName = leadNameOf(loaded.definition)
      const wantsModel = input.applyModel === true && model !== null && leadName !== null
      let leadRowId: string | null = null
      if (wantsModel) {
        const leadRows = await tx.companySlave.findMany({ where: { name: leadName as string, companyTeam: { companyId } }, select: { id: true } })
        if (leadRows.length !== 1) {
          throw new AdoptionRefused({ kind: 'invalid_simulation_input', detail: "the lead's name is ambiguous in the roster; set the model by hand" })
        }
        leadRowId = leadRows[0]?.id ?? null
      }

      const roleOverrides = roleOverridesOf(loaded.definition)
      const assigned = await assignCompanyTx(tx, input.workspaceId, companyId, { roleOverrides })
      if (!assigned.ok) throw new AdoptionRefused(assigned.error)

      const proposal = proposedSettings(loaded.definition)
      const settings = {
        maxConcurrentRuns: input.maxConcurrentRuns ?? proposal.maxConcurrentRuns,
        maxAttempts: input.maxAttempts ?? proposal.maxAttempts,
      }
      await tx.workspace.update({
        where: { id: input.workspaceId },
        // `autoMerge: false` is written, not left alone (§1 principle 3): a project that had it on
        // must not start merging a freshly adopted organisation's work unattended.
        data: { ...settings, autoMerge: false, adoptedFromSimulationId: simulationId },
      })

      let appliedModel: { readonly provider: string; readonly model: string } | null = null
      if (leadRowId !== null && model !== null) {
        await tx.companySlave.update({ where: { id: leadRowId }, data: { model: model.model, provider: model.provider } })
        appliedModel = model
      }

      // `max(seq) + 1` read fresh under this row's lock, and the watermark moved with it (M32 item
      // 3) -- every other writer computes its next seq from `state.journalSeq`, so a journal row
      // written without moving it is a `(simulationId, seq)` collision waiting to happen.
      const last = await tx.simulationJournalEntry.findFirst({ where: { simulationId }, orderBy: { seq: 'desc' }, select: { seq: true } })
      const seq = (last?.seq ?? -1) + 1
      await tx.simulationJournalEntry.create({
        data: {
          simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null,
          idempotencyKey: input.idempotencyKey !== undefined ? namespacedKey('adopt', input.idempotencyKey) : null,
          // The RUN's own role assignment, not the two translated entries (R2): the journal is the
          // record of what the simulation decided, and `product`/an engineer's expertise are part
          // of that even though no `Slave.role` carries them.
          payload: json({ op: 'adopted', workspaceId: target.id, workspaceName: target.name, settings, roles: runRolesOf(loaded.definition), appliedModel }),
        },
      })
      await tx.simulationRun.update({ where: { id: simulationId }, data: watermark(row.state, seq) })

      return { replayed: false as const, workspaceId: target.id, assigned: assigned.value }
      // `RepeatableRead` as §3 asks. The two `FOR UPDATE` locks are what actually make this
      // correct; the level is here so every multi-read transaction in this package reads from one
      // snapshot the same way (`read.ts`'s three do).
    }, { isolationLevel: 'RepeatableRead' })

    // Outside the transaction, exactly where `assignCompany` emits it: the project really was
    // assigned a company, and M11's overview reads that event. A replay emits nothing -- the first
    // call already did.
    if (!outcome.replayed) {
      const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } })
      await appendEvent({
        type: 'workspace.company_assigned',
        workspaceId: outcome.workspaceId,
        actor: 'human',
        payload: { company: company?.name ?? '', workers: outcome.assigned.createdWorkers },
        userId: principal?.userId ?? null,
      })
    }

    return ok({ workspaceId: outcome.workspaceId, assigned: outcome.assigned })
  } catch (error) {
    // `AssignmentRefused` (M34 t2 fix round 2) is `assignCompanyTx`'s OWN post-write refusal,
    // thrown from inside the `assignCompanyTx` call above rather than returned as a value -- see
    // that class's doc comment in `org.ts`. Unwrapped here the same way `AdoptionRefused` is,
    // rather than adding a second `try`/`catch` around just that one call.
    if (error instanceof AdoptionRefused || error instanceof AssignmentRefused) return err(error.refusal)
    throw error
  }
}
