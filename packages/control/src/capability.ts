import { CAPABILITY_SEED } from '@slave-of-ai/db'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  CAPABILITY_KEY_PATTERN,
  NON_TERMINAL_RUN_STATUSES,
  err,
  normaliseCapabilities,
  ok,
  projectRoles,
  type CapabilityRecord,
  type Result,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { AssignmentRefused, departmentFor } from './department.js'
import type { ControlRefusal } from './refusal.js'

/** Every taxonomy row, KEY ASCENDING -- the order every caller gets, so `normaliseCapabilities`'
 *  "first spelling wins" rule and `formTeam`'s tie-breaks are decided by the taxonomy itself and
 *  never by what Postgres felt like returning. */
export async function listCapabilities(): Promise<readonly CapabilityRecord[]> {
  const rows = await prisma.capability.findMany({ orderBy: { key: 'asc' } })
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    domain: row.domain,
    role: row.role,
    synonyms: row.synonyms,
  }))
}

/**
 * Reconcile the table against the checked-in list (R1): create what is missing, bring a `seed` row
 * back to what the list says, and never touch a row an operator added.
 *
 * Run by `db:seed`, by `importCatalog` before it normalises anything, and by `capabilities sync`.
 * Idempotent by construction -- the second run reports `{ created: 0, updated: 0 }`, which is what
 * makes it safe to call at the top of every import.
 */
export async function syncCapabilityTaxonomy(): Promise<{ readonly created: number; readonly updated: number }> {
  const existing = new Map((await prisma.capability.findMany()).map((row) => [row.key, row] as const))
  let created = 0
  let updated = 0
  for (const record of CAPABILITY_SEED) {
    const row = existing.get(record.key)
    if (row === undefined) {
      await prisma.capability.create({
        data: {
          key: record.key,
          label: record.label,
          domain: record.domain,
          role: record.role,
          synonyms: [...record.synonyms],
          createdBy: 'seed',
        },
      })
      created += 1
      continue
    }
    // An operator's own row is theirs, even when its key collides with one the list later gained:
    // `createdBy` is the whole of that promise.
    if (row.createdBy !== 'seed') continue
    const same =
      row.label === record.label &&
      row.domain === record.domain &&
      row.role === record.role &&
      row.synonyms.length === record.synonyms.length &&
      row.synonyms.every((synonym, index) => synonym === record.synonyms[index])
    if (same) continue
    await prisma.capability.update({
      where: { key: record.key },
      data: { label: record.label, domain: record.domain, role: record.role, synonyms: [...record.synonyms] },
    })
    updated += 1
  }
  return { created, updated }
}

/** An operator's own capability (R1). `domain` is not a parameter: it IS the key's prefix, and a
 *  row whose domain disagreed with its key would make the facet list lie. */
export async function addCapability(input: {
  readonly key: string
  readonly label: string
  readonly role: string
  readonly synonyms?: readonly string[]
}): Promise<Result<CapabilityRecord, ControlRefusal>> {
  const key = input.key.trim()
  const label = input.label.trim()
  const role = input.role.trim()
  if (!CAPABILITY_KEY_PATTERN.test(key)) {
    return err({
      kind: 'invalid_capability',
      detail: `"${key}" is not a key: a key looks like <domain>.<name>, lower case and dash-separated`,
    })
  }
  if (label === '') return err({ kind: 'invalid_capability', detail: 'a capability needs a label a person can read' })
  if (role === '') return err({ kind: 'invalid_capability', detail: 'a capability needs the runtime role it projects to' })
  const synonyms = (input.synonyms ?? []).map((synonym) => synonym.trim()).filter((synonym) => synonym !== '')
  const existing = await prisma.capability.findUnique({ where: { key } })
  if (existing !== null) return err({ kind: 'invalid_capability', detail: `"${key}" is already in the taxonomy` })
  const domain = key.split('.')[0] as string
  const row = await prisma.capability.create({ data: { key, label, domain, role, synonyms, createdBy: 'human' } })
  return ok({ key: row.key, label: row.label, domain: row.domain, role: row.role, synonyms: row.synonyms })
}

/**
 * What a worker PROVIDES, set by an operator (R2).
 *
 * The capabilities REPLACE (the `setRuntimeRoles` convention: naming two means holding exactly
 * those two afterwards); the runtime roles are UNIONED, because taking a role away as a side
 * effect of describing a skill would park a worker mid-project. `set-runtime-roles` stays the way
 * a role is removed.
 */
export async function setSlaveCapabilities(
  slaveId: string,
  values: readonly string[],
  actor: string,
): Promise<
  Result<
    { readonly keys: readonly string[]; readonly unresolved: readonly string[]; readonly runtimeRoles: readonly string[] },
    ControlRefusal
  >
> {
  const taxonomy = await listCapabilities()
  const { keys, unresolved } = normaliseCapabilities(values, taxonomy)
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockedSlave(tx, slaveId)
    if (slave === null) return null
    const runtimeRoles = [...slave.runtimeRoles]
    for (const role of projectRoles(keys, taxonomy)) if (!runtimeRoles.includes(role)) runtimeRoles.push(role)
    await tx.slave.update({ where: { id: slaveId }, data: { capabilities: [...keys], runtimeRoles } })
    return { workspaceId: slave.workspaceId, runtimeRoles }
  })
  if (outcome === null) return err({ kind: 'slave_not_found', slaveId })
  await appendEvent({
    type: 'slave.runtime_roles_changed',
    workspaceId: outcome.workspaceId,
    slaveId,
    actor: 'human',
    payload: { slaveId, roles: outcome.runtimeRoles, actor },
  })
  return ok({ keys, unresolved, runtimeRoles: outcome.runtimeRoles })
}

/**
 * Add runtime roles to a worker WITHOUT ever taking one away, with the read and the write under one
 * lock (fix round 1, Important 1).
 *
 * `setRuntimeRoles` (`profile.ts`) is a REPLACEMENT -- that is its contract, and the operator-facing
 * verb should keep it. M38's `addRuntimeRoles` therefore read the worker outside that verb's own
 * transaction, unioned in JavaScript and handed the result over to be written verbatim, which is a
 * lost update waiting for a second writer. It waited until M47: `assign_capability` is the first
 * runtime-role write a TICK makes by itself, so `setSlaveCapabilities` committing a role between
 * that read and that write would have had it silently deleted a moment later.
 *
 * So: `FOR UPDATE` on the row, read, union, update, one transaction -- `setSlaveCapabilities`'
 * shape exactly, through the same {@link lockedSlave}. HELD FIRST, then whatever is new, which is
 * the order M37's own union writes and the order the panel reads.
 *
 * The event is appended only when the set actually MOVED. A `slave.runtime_roles_changed` whose
 * roles equal yesterday's is noise on a timeline a person reads, and an approval of a proposal
 * somebody has meanwhile satisfied by hand is exactly how one arrives.
 *
 * `slave_not_found` is reached before anything is written, so it is RETURNED rather than thrown --
 * the transaction has nothing to roll back.
 */
export async function mergeRuntimeRoles(
  slaveId: string,
  adds: readonly string[],
  actor: string,
  origin: 'human' | 'system' = 'human',
): Promise<Result<{ readonly runtimeRoles: readonly string[] }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockedSlave(tx, slaveId)
    if (slave === null) return null
    const runtimeRoles = [...slave.runtimeRoles]
    for (const role of adds) {
      const trimmed = role.trim()
      // A blank role is not a role. `actionSchema` already refuses one on the way in
      // (`role: z.string().min(1)`); dropping it here means a hand-edited row cannot write an
      // empty string into a set the scheduler matches on.
      if (trimmed !== '' && !runtimeRoles.includes(trimmed)) runtimeRoles.push(trimmed)
    }
    // Both sets only ever grow here, so a length that did not move is a set that did not move --
    // the same reading `hireFromTemplate`'s reuse branch makes.
    const changed = runtimeRoles.length !== slave.runtimeRoles.length
    if (changed) await tx.slave.update({ where: { id: slaveId }, data: { runtimeRoles } })
    return { workspaceId: slave.workspaceId, runtimeRoles, changed }
  })
  if (outcome === null) return err({ kind: 'slave_not_found', slaveId })
  if (outcome.changed) {
    await appendEvent({
      type: 'slave.runtime_roles_changed',
      workspaceId: outcome.workspaceId,
      slaveId,
      actor: origin,
      payload: { slaveId, roles: outcome.runtimeRoles, actor },
    })
  }
  return ok({ runtimeRoles: outcome.runtimeRoles })
}

/** The row plus the workspace the event needs, under `FOR UPDATE` -- `lockSlave`'s shape from
 *  `org.ts`, re-read here because that helper returns the whole include and this file needs two
 *  fields. */
async function lockedSlave(
  tx: Prisma.TransactionClient,
  slaveId: string,
): Promise<{ readonly runtimeRoles: readonly string[]; readonly workspaceId: string } | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Slave" WHERE id = ${slaveId} FOR UPDATE`
  if (locked.length === 0) return null
  const row = await tx.slave.findUnique({
    where: { id: slaveId },
    select: { runtimeRoles: true, team: { select: { workspaceId: true } } },
  })
  return row === null ? null : { runtimeRoles: row.runtimeRoles, workspaceId: row.team.workspaceId }
}

/**
 * ONE company roster worker onto ONE project (R4) -- the single-worker sibling of
 * `assignCompanyTx`, which materialises a whole company.
 *
 * Idempotent on the roster row: a `CompanySlave` already materialised into this workspace is
 * RETURNED, never doubled. The department is found or created from the roster team exactly as
 * `assignCompanyTx` does, so a project staffed one worker at a time and one assigned wholesale end
 * up with the same shape.
 */
export async function materialiseCompanySlave(
  workspaceId: string,
  companySlaveId: string,
  opts: { readonly rationale?: string } = {},
): Promise<Result<{ readonly slaveId: string; readonly created: boolean }, ControlRefusal>> {
  const taxonomy = await listCapabilities()
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const roster = await prisma.companySlave.findUnique({
    where: { id: companySlaveId },
    include: { companyTeam: true, template: true },
  })
  if (roster === null) return err({ kind: 'company_slave_not_found', companySlaveId })

  const capabilities = roster.template.capabilityKeys
  const runtimeRoles = [...new Set([roster.template.role, ...projectRoles(capabilities, taxonomy)])]

  let created: { readonly id: string; readonly name: string } | null
  try {
    created = await prisma.$transaction(async (tx) => {
      // The workspace row under `FOR UPDATE` before the existence check (fix round 1, minor 2):
      // `Slave.companySlaveId` has no unique index, so nothing else serialises two callers
      // materialising the same roster row, and both would read "not there" and create a worker
      // each. `assignCompanyTx` locks the same row for the same reason.
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      const existing = await tx.slave.findFirst({ where: { companySlaveId, team: { workspaceId } } })
      if (existing !== null) return null

      const { team } = await departmentFor(tx, workspaceId, roster.companyTeam)
      return tx.slave.create({
        data: {
          teamId: team.id,
          name: uniqueSlaveName(
            await tx.slave.findMany({ where: { team: { workspaceId } }, select: { name: true } }),
            roster.name,
          ),
          role: roster.template.role,
          runtimeRoles,
          capabilities: [...capabilities],
          companySlaveId,
          ...(opts.rationale === undefined ? {} : { selectionRationale: opts.rationale }),
        },
      })
    })
  } catch (error) {
    // `departmentFor`'s one post-write refusal, unwrapped exactly as `assignCompany` unwraps it.
    if (error instanceof AssignmentRefused) return err(error.refusal)
    throw error
  }

  if (created === null) {
    const existing = await prisma.slave.findFirstOrThrow({ where: { companySlaveId, team: { workspaceId } } })
    return ok({ slaveId: existing.id, created: false })
  }

  await appendEvent({
    type: 'org.changed',
    workspaceId,
    slaveId: created.id,
    actor: 'system',
    payload: { entity: 'slave', id: created.id, field: 'created', from: null, to: created.name },
  })
  return ok({ slaveId: created.id, created: true })
}

/**
 * A NEW project worker, straight from a catalog template (R4) -- the case where neither the
 * project nor the company roster can do the work.
 *
 * REUSES rather than duplicates (plan erratum E10): one supervised pass decides every fresh
 * situation, so two `capability_unstaffed` situations can both land on the same template, and a
 * second approval must not put a second copy of the same specialist on the project. The existing
 * worker gains whatever capabilities and roles the second hire would have brought, and keeps the
 * rationale of the hire that actually created it -- that sentence is why it is here.
 *
 * `temporary` is recorded in the rationale and nowhere else until M50 owns the lifecycle: a column
 * nothing releases would be a promise the system cannot keep.
 */
export async function hireFromTemplate(
  workspaceId: string,
  templateId: string,
  opts: { readonly capabilities?: readonly string[]; readonly rationale: string; readonly temporary?: boolean },
): Promise<
  Result<
    {
      readonly slaveId: string
      readonly reused: boolean
      readonly capabilities: readonly string[]
      readonly runtimeRoles: readonly string[]
    },
    ControlRefusal
  >
> {
  const taxonomy = await listCapabilities()
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const template = await prisma.slaveTemplate.findUnique({ where: { id: templateId } })
  if (template === null) return err({ kind: 'template_not_found', templateId })

  const asked = opts.capabilities ?? []
  for (const key of asked) {
    if (!taxonomy.some((record) => record.key === key)) return err({ kind: 'capability_not_found', key })
  }
  const capabilities = [...new Set([...template.capabilityKeys, ...asked])].toSorted()
  const runtimeRoles = [...new Set([template.role, ...projectRoles(capabilities, taxonomy)])]
  const rationale = opts.temporary === true ? `${opts.rationale} (asked for as a temporary specialist)` : opts.rationale

  // The reuse decision and the write it implies happen under ONE workspace row lock (fix round 1,
  // minor 2). There is no unique index on `hiredFromTemplateId`, so without it two approvals of the
  // same proposal -- which is exactly what E10 says one supervised pass can produce -- would both
  // read "nobody hired yet" and put two copies of one specialist on the project.
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const existing = await tx.slave.findFirst({
      where: { hiredFromTemplateId: templateId, team: { workspaceId } },
      orderBy: { id: 'asc' },
    })
    if (existing !== null) {
      const merged = [...new Set([...existing.capabilities, ...capabilities])].toSorted()
      const roles = [...existing.runtimeRoles]
      for (const role of runtimeRoles) if (!roles.includes(role)) roles.push(role)
      // Both sets only ever grow here, so a length that did not move is a set that did not move.
      const rolesChanged = roles.length !== existing.runtimeRoles.length
      const capabilitiesChanged = merged.length !== existing.capabilities.length
      if (rolesChanged || capabilitiesChanged) {
        await tx.slave.update({ where: { id: existing.id }, data: { capabilities: merged, runtimeRoles: roles } })
      }
      return {
        kind: 'reused' as const,
        slaveId: existing.id,
        capabilities: merged,
        runtimeRoles: roles,
        before: existing.capabilities,
        rolesChanged,
        capabilitiesChanged,
      }
    }

    const teams = await tx.team.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } })
    // A hire needs a department. The first by name is deterministic and is the one a
    // single-department project has; a project with none gets `Specialists`, which says what it
    // is rather than borrowing a name from a company this project may not have.
    const team = teams[0] ?? (await tx.team.create({ data: { workspaceId, name: 'Specialists' } }))
    const worker = await tx.slave.create({
      data: {
        teamId: team.id,
        name: uniqueSlaveName(
          await tx.slave.findMany({ where: { team: { workspaceId } }, select: { name: true } }),
          template.name,
        ),
        role: template.role,
        runtimeRoles,
        capabilities,
        hiredFromTemplateId: templateId,
        selectionRationale: rationale,
      },
    })
    return { kind: 'created' as const, slaveId: worker.id, name: worker.name }
  })

  if (outcome.kind === 'created') {
    await appendEvent({
      type: 'org.changed',
      workspaceId,
      slaveId: outcome.slaveId,
      actor: 'system',
      payload: { entity: 'slave', id: outcome.slaveId, field: 'created', from: null, to: outcome.name },
    })
    return ok({ slaveId: outcome.slaveId, reused: false, capabilities, runtimeRoles })
  }

  // A reuse that CHANGED the worker is a write, and a write nobody can see in the log is how a
  // roster grows roles nobody remembers granting (fix round 1, minor 3). The role set moving is
  // the bigger fact -- it is what the scheduler matches -- so it takes the event `setRuntimeRoles`
  // itself writes; a merge that only added keys takes `org.changed`. A reuse that changed neither
  // wrote nothing, and has nothing to record.
  if (outcome.rolesChanged) {
    await appendEvent({
      type: 'slave.runtime_roles_changed',
      workspaceId,
      slaveId: outcome.slaveId,
      actor: 'system',
      payload: { slaveId: outcome.slaveId, roles: outcome.runtimeRoles, actor: 'hire' },
    })
  } else if (outcome.capabilitiesChanged) {
    await appendEvent({
      type: 'org.changed',
      workspaceId,
      slaveId: outcome.slaveId,
      actor: 'system',
      payload: {
        entity: 'slave',
        id: outcome.slaveId,
        field: 'capabilities',
        from: outcome.before.length === 0 ? null : [...outcome.before].toSorted().join(', '),
        to: outcome.capabilities.join(', '),
      },
    })
  }
  return ok({ slaveId: outcome.slaveId, reused: true, capabilities: outcome.capabilities, runtimeRoles: outcome.runtimeRoles })
}

/** `Name`, then `Name 2`, `Name 3`… -- a project may already have a worker with the template's
 *  name (a legacy hand-made one, or one from a company whose roster borrowed it), and there is no
 *  unique index to lean on here. Deterministic and readable, which a uuid suffix would not be. */
function uniqueSlaveName(existing: readonly { readonly name: string }[], wanted: string): string {
  const taken = new Set(existing.map((row) => row.name))
  if (!taken.has(wanted)) return wanted
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted} ${String(n)}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Who is on this project, what they provide and why they are here (R6) -- the read behind the
 *  Organization view and behind `formTeam`'s roster. One query for the workers, one for the hints
 *  their templates carry; never a query per worker. */
export interface OrganizationWorker {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly runtimeRoles: readonly string[]
  readonly capabilities: readonly string[]
  readonly kind: 'company' | 'project'
  readonly companyName: string | null
  readonly hiredFromTemplateId: string | null
  readonly hiredFromTemplateName: string | null
  readonly selectionRationale: string | null
  readonly busy: boolean
}

export interface OrganizationView {
  readonly workers: readonly OrganizationWorker[]
  readonly hints: readonly {
    readonly slaveId: string
    readonly text: string
    readonly targetTemplateName: string | null
    readonly capability: string | null
  }[]
}

export async function listOrganization(workspaceId: string): Promise<Result<OrganizationView, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const rows = await prisma.slave.findMany({
    where: { team: { workspaceId } },
    orderBy: { name: 'asc' },
    include: {
      hiredFromTemplate: { select: { id: true, name: true } },
      companySlave: {
        include: {
          template: { select: { id: true, name: true } },
          companyTeam: { include: { company: { select: { name: true } } } },
        },
      },
      // `NON_TERMINAL_RUN_STATUSES`, the repository's one list of "this run is still going"
      // (`supervisorWorld.ts`'s roster read uses the same one) -- never a hand-written status list
      // here, which would drift from the enum the moment a status is added.
      runs: { where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } }, select: { id: true }, take: 1 },
    },
  })

  const templateBySlave = new Map(
    rows.flatMap((row) => {
      const templateId = row.hiredFromTemplate?.id ?? row.companySlave?.template.id ?? null
      return templateId === null ? [] : [[row.id, templateId] as const]
    }),
  )
  const hintRows =
    templateBySlave.size === 0
      ? []
      : await prisma.collaborationHint.findMany({
          where: { templateId: { in: [...new Set(templateBySlave.values())] } },
          include: { targetTemplate: { select: { name: true } } },
          orderBy: [{ templateId: 'asc' }, { text: 'asc' }],
        })

  return ok({
    workers: rows.map((row) => ({
      slaveId: row.id,
      name: row.name,
      role: row.role,
      runtimeRoles: row.runtimeRoles,
      capabilities: row.capabilities,
      kind: row.companySlaveId === null ? 'project' : 'company',
      companyName: row.companySlave?.companyTeam.company.name ?? null,
      hiredFromTemplateId: row.hiredFromTemplate?.id ?? null,
      hiredFromTemplateName: row.hiredFromTemplate?.name ?? null,
      selectionRationale: row.selectionRationale,
      busy: row.runs.length > 0,
    })),
    hints: [...templateBySlave].flatMap(([slaveId, templateId]) =>
      hintRows
        .filter((hint) => hint.templateId === templateId)
        .map((hint) => ({
          slaveId,
          text: hint.text,
          targetTemplateName: hint.targetTemplate?.name ?? null,
          capability: hint.capability,
        })),
    ),
  })
}
