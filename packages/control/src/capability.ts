import { CAPABILITY_SEED } from '@slave-of-ai/db'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  CAPABILITY_KEY_PATTERN,
  NON_TERMINAL_RUN_STATUSES,
  capabilityGrantDelta,
  capabilityLabel,
  effectiveCapabilities,
  err,
  functionalDepartmentFor,
  normaliseCapabilities,
  normaliseCapabilityText,
  ok,
  profileSpecSchema,
  projectRoles,
  type CapabilityRecord,
  type Result,
  type SlaveLifecycle,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { AssignmentRefused, departmentFor } from './department.js'
import { selectPoolPerson, syncPersonPool, type PersonPoolSyncReport } from './personPool.js'
import { MAX_RUNTIME_ROLES } from './profile.js'
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

/** Whether two capability-key (or unresolved-text) arrays hold the same SET -- order never
 *  mattered to anything that reads either column, and comparing positionally would report a write
 *  every time a re-derivation happens to walk `profileSpec.capabilities` in a different order than
 *  the row was last written with. The `syncPersonPool`/`sameCapabilitySet` idiom (`personPool.ts`),
 *  restated here because the two columns it compares (`Person.capabilities`, one array) are not
 *  the two this function compares (`SlaveTemplate.capabilityKeys` AND
 *  `.unresolvedCapabilities`, two arrays; Task 3). */
function sameStringSet(current: readonly string[], desired: readonly string[]): boolean {
  if (current.length !== desired.length) return false
  const want = new Set(desired)
  return current.every((value) => want.has(value))
}

/**
 * Catalogue capability mapping (2026-09-20), R3: the EFFECTIVE capability set of a template --
 * what the exact matcher found by word, plus what a model mapped -- deduplicated and key
 * ascending, so two writers producing the same set produce the same array. Every writer of
 * `SlaveTemplate.capabilityKeys` goes through this: the three import sites, the reconcile pass and
 * the mapping pass. Readers keep reading `capabilityKeys` and see both halves.
 */
export function effectiveCapabilityKeys(exact: readonly string[], mapped: readonly string[]): string[] {
  return [...new Set([...exact, ...mapped])].toSorted()
}

/** What one {@link reconcileTemplateCapabilities} pass did. */
export interface CapabilityReconcileReport {
  /** How many templates carried a PARSEABLE `profileSpec` and were actually re-derived. A
   *  hand-made template (no `profileSpec` at all) is never in this count -- Task 3's rule that a
   *  persona nobody structured is never guessed at. */
  readonly templates: number
  /** How many of those templates had their stored `capabilityKeys`/`unresolvedCapabilities`
   *  actually written -- only when the freshly-derived SET disagreed with what was stored. */
  readonly updated: number
  /** Distinct SOURCE capability strings (verbatim, across every scanned template's
   *  `profileSpec.capabilities`) that resolved to a taxonomy key after this pass -- a count of
   *  VALUES, never of templates, so a phrase five personas share is counted once (Task 3). */
  readonly resolved: number
  /** The same count, for every distinct source string that matched nothing. */
  readonly unresolved: number
  /** The ids of every template whose `profileSpec` column is non-null but failed
   *  {@link profileSpecSchema} -- a hand-edited or pre-migration row this pass could not read.
   *  Skipped, never crashed on and never overwritten (Task 3): the ids are the "bounded warning"
   *  an operator can act on, and the count of the array is the number a caller would otherwise
   *  have to log separately. */
  readonly malformed: readonly string[]
  /** What the `syncPersonPool()` pass this call ran at the end of itself did (final review,
   *  Important 4). Nested rather than discarded: this pass has ALWAYS ended with that sync, and a
   *  caller that wanted its numbers used to run a second one to get them -- a full extra scan of
   *  every active template whose only honest answer was "nothing changed". */
  readonly pool: PersonPoolSyncReport
}

/**
 * Re-derives every STRUCTURED template's `capabilityKeys`/`unresolvedCapabilities` from its own
 * `profileSpec.capabilities` against the taxonomy AS IT STANDS RIGHT NOW (Task 3).
 *
 * The gap this closes: an import only re-runs `normaliseCapabilities` for a row whose FILE
 * changed (`importCatalog`'s case (c), `catalog.ts`) -- so a synonym added to the taxonomy after a
 * persona was imported never repairs that persona's `unresolvedCapabilities`, however safe the new
 * alias is. This pass is the repair: it reads the taxonomy once, walks every template that HAS a
 * `profileSpec` (a hand-made row has none and is never guessed at, R1's own rule extended), and
 * writes back only the rows whose freshly-computed SET actually differs from what is stored.
 *
 * `normaliseCapabilities` itself is UNCHANGED -- exact key, exact label or exact synonym, still no
 * fuzzy matching, still no substrings. This function is purely about WHEN that comparison runs,
 * never about HOW it matches.
 *
 * A malformed `profileSpec` (non-null, but failing {@link profileSpecSchema}) does not stop the
 * pass and is never overwritten: its id is collected in {@link CapabilityReconcileReport.malformed}
 * instead, and the row this pass cannot read is left exactly as it was.
 *
 * `syncPersonPool()` runs LAST, off the capabilities this pass just wrote -- every active
 * template's managed people pick up a repaired key on the same call that repaired it, and a manual
 * person (`poolSlot: null`) is outside `syncPersonPool`'s own query and is never touched here
 * either. Its report comes back in {@link CapabilityReconcileReport.pool} (final review, Important
 * 4), so the callers that used to run their own `syncPersonPool()` immediately afterwards purely
 * to have numbers to print can stop: the sync happened, and these are its numbers.
 */
export async function reconcileTemplateCapabilities(): Promise<CapabilityReconcileReport> {
  const taxonomy = await listCapabilities()
  const rows = await prisma.slaveTemplate.findMany({
    select: { id: true, profileSpec: true, capabilityKeys: true, unresolvedCapabilities: true, mappedCapabilityKeys: true },
    orderBy: { id: 'asc' },
  })

  let templates = 0
  let updated = 0
  const malformed: string[] = []
  const resolvedValues = new Set<string>()
  const unresolvedValues = new Set<string>()

  for (const row of rows) {
    // A hand-made template, or one imported before M46 and never re-imported: nothing to read,
    // and R1's own rule ("nothing matches on a key that is not a row") extended to "nothing is
    // derived from text that is not there" -- never guessed, never rewritten.
    if (row.profileSpec === null) continue
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    if (!spec.success) {
      malformed.push(row.id)
      continue
    }
    templates += 1

    const { keys, unresolved } = normaliseCapabilities(spec.data.capabilities, taxonomy)
    for (const value of spec.data.capabilities) {
      if (normaliseCapabilityText(value) === '') continue // blank: not a capability value at all
      if (unresolved.includes(value)) unresolvedValues.add(value)
      else resolvedValues.add(value)
    }

    const effective = effectiveCapabilityKeys(keys, row.mappedCapabilityKeys)
    if (sameStringSet(row.capabilityKeys, effective) && sameStringSet(row.unresolvedCapabilities, unresolved)) continue
    await prisma.slaveTemplate.update({
      where: { id: row.id },
      data: { capabilityKeys: effective, unresolvedCapabilities: [...unresolved] },
    })
    updated += 1
  }

  // LAST, and off what THIS pass just wrote (Task 3 brief, R7): an active template whose keys this
  // pass repaired must have its managed people's capabilities repaired on the same call, never on
  // the next unrelated hook to run.
  const pool = await syncPersonPool()

  return { templates, updated, resolved: resolvedValues.size, unresolved: unresolvedValues.size, malformed, pool }
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
 * What a PERSON provides, set by an operator (R2).
 *
 * M58 R1: the capability set is one fact about one specialist and lives on `Person`; the runtime
 * roles it projects to are a schedule decision and live on every OPEN seat that person holds. So
 * this verb writes one person row and unions the projected roles into each of their seats.
 *
 * The capabilities REPLACE (the `setRuntimeRoles` convention: naming two means holding exactly
 * those two afterwards); the runtime roles are UNIONED, because taking a role away as a side
 * effect of describing a skill would park a worker mid-project. `set-runtime-roles` stays the way
 * a role is removed.
 *
 * TWO events, each only when its own half actually moved (M47 final review, Minor 8). This verb
 * wrote `slave.runtime_roles_changed` unconditionally, so re-running it with the same list put a
 * role-change on the timeline where no role had changed -- and writing the capability set, the
 * thing the operator actually asked for, showed up nowhere at all. The capability event is
 * `org.changed { field: 'capabilities' }`, the same one `hireFromTemplate`'s reuse branch writes,
 * carrying LABELS (Minor 5c).
 *
 * The cap is checked BEFORE the write and returned as a value (Minor 7): the union can carry a
 * worker past `MAX_RUNTIME_ROLES`, and a set this verb wrote is one `setRuntimeRoles` would refuse
 * to.
 *
 * **A MANAGED person's request is the desired EFFECTIVE set** (final review, Important 2). Somebody
 * holding a `poolSlot` provides two things: their template's baseline, which `syncPersonPool`
 * rewrites on every pass, and whatever was granted them on top of it. A plain replacement here
 * would therefore last exactly until the next sync. So for a managed person the request is read as
 * "this is what they should provide": the part of it BEYOND the baseline is stored as
 * `capabilityGrants`, the baseline is restored in full, and the effective union is what lands in
 * `capabilities` and what the caller reads back. Baseline keys cannot be removed from one
 * person -- taking a capability off the persona is a template edit, and pretending otherwise would
 * produce a set the next sync silently undoes.
 *
 * An unmanaged person is untouched by any of that: no baseline, no grants written, and the plain
 * replacement this verb has always done.
 *
 * The runtime roles are projected from the EFFECTIVE set, not from the request, which is why the
 * projection moved inside the transaction: the effective set is only known once the person has been
 * read, and a role set computed off the narrower request would silently skip a baseline key's role.
 */
export async function setPersonCapabilities(
  personId: string,
  values: readonly string[],
  actor: string,
): Promise<
  Result<
    { readonly keys: readonly string[]; readonly unresolved: readonly string[]; readonly runtimeRoles: readonly string[] },
    ControlRefusal
  >
> {
  const taxonomy = await listCapabilities()
  const { keys: requested, unresolved } = normaliseCapabilities(values, taxonomy)
  const outcome = await prisma.$transaction(async (tx) => {
    // The person AND every seat this write will touch, under `FOR UPDATE` before either is read
    // (final review's Important 1, restated for the split): the runtime-role union below is
    // computed off these reads, and `setRuntimeRoles`/`mergeRuntimeRoles` lock the SEAT row -- so
    // without the second lock a role granted between the read and the write is silently dropped.
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM "Slave" WHERE "personId" = ${personId} AND "closedAt" IS NULL ORDER BY id FOR UPDATE`
    const person = await tx.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        capabilities: true,
        // Final review, Important 2: which of the two shapes this person is, and the grant half
        // of their set -- both read under the lock the write takes, so a concurrent pool sync
        // cannot have moved the baseline underneath the union computed below.
        poolSlot: true,
        capabilityGrants: true,
        template: { select: { capabilityKeys: true } },
        // M58 R1: what a specialist provides is the PERSON's; the runtime roles it projects to are
        // each SEAT's, so the union below is written once per open seat and never to a closed one.
        seats: { where: { closedAt: null }, select: { id: true, runtimeRoles: true, team: { select: { workspaceId: true } } } },
      },
    })
    if (person === null) return { refusal: { kind: 'person_not_found', personId } as ControlRefusal }

    // MANAGED means holding a pool slot, which the schema's own CHECK guarantees comes with a
    // template: the `template === null` half of this test is unreachable through the database and
    // is written anyway so this expression is total rather than asserted.
    const baseline = person.poolSlot === null || person.template === null ? null : person.template.capabilityKeys
    const grants = baseline === null ? null : capabilityGrantDelta(requested, baseline)
    const keys = baseline === null || grants === null ? requested : effectiveCapabilities(baseline, grants)
    const projected = projectRoles(keys, taxonomy)

    const seats = person.seats.map((seat) => {
      const runtimeRoles = [...seat.runtimeRoles]
      for (const role of projected) if (!runtimeRoles.includes(role)) runtimeRoles.push(role)
      return { ...seat, next: runtimeRoles, changed: runtimeRoles.length !== seat.runtimeRoles.length }
    })
    // Before any update, inside the lock: nothing has been written, so this is a returned value and
    // the transaction has nothing to roll back.
    for (const seat of seats) {
      const refusal = overCap(seat.next)
      if (refusal !== null) return { refusal }
    }
    const before = [...person.capabilities]
    await tx.person.update({
      where: { id: personId },
      // `capabilityGrants` only for a managed person: an unmanaged one has no baseline to
      // subtract, so writing the request there would invent a distinction the row does not have.
      data: { capabilities: [...keys], ...(grants === null ? {} : { capabilityGrants: grants }) },
    })
    for (const seat of seats) {
      if (seat.changed) await tx.slave.update({ where: { id: seat.id }, data: { runtimeRoles: seat.next } })
    }
    return {
      seats,
      before,
      keys,
      // A REPLACEMENT, so "changed" is a set comparison and not a length one: naming the same two
      // capabilities in the other order is not a change, and swapping one for another is.
      capabilitiesChanged: before.length !== keys.length || before.some((key) => !keys.includes(key)),
    }
  })
  if ('refusal' in outcome) return err(outcome.refusal)
  const keys = outcome.keys
  for (const seat of outcome.seats) {
    if (!seat.changed) continue
    await appendEvent({
      type: 'slave.runtime_roles_changed',
      workspaceId: seat.team.workspaceId,
      slaveId: seat.id,
      actor: 'human',
      payload: { slaveId: seat.id, personId, roles: seat.next, actor },
    })
  }
  if (outcome.capabilitiesChanged) {
    for (const seat of outcome.seats) {
      await appendEvent({
        type: 'org.changed',
        workspaceId: seat.team.workspaceId,
        slaveId: seat.id,
        actor: 'human',
        payload: {
          entity: 'slave',
          id: seat.id,
          personId,
          field: 'capabilities',
          from: capabilityLabels([...outcome.before].toSorted(), taxonomy),
          to: capabilityLabels(keys, taxonomy),
        },
      })
    }
  }
  // The roles reported are the FIRST open seat's -- the same single answer the verb gave when a
  // person could only ever have one. A person with no open seat holds no runtime roles anywhere,
  // and the empty list is the honest answer rather than a set nobody can be dispatched with.
  return ok({ keys, unresolved, runtimeRoles: outcome.seats[0]?.next ?? [] })
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
 *
 * **A released worker is refused** (M50 final review, Important 1). A release is permanent: it
 * writes `runtimeRoles = []`, and that empty set is the WHOLE of how a released worker stops being
 * dispatched (`lifecycle.ts`). Every producer of an `assign_capability` proposal already skips a
 * released worker at DRAFT time -- `staffableSlaves` and `formTeam`'s roster both filter on it --
 * but a proposal may sit `pending` for a whole `PENDING_TTL_MS`, and an approval that lands after
 * the release re-armed the worker for good: `isReleasable` refuses an already-released row, so
 * `engagement_over` could never take the role back off again. This is the apply-time re-check, in
 * the verb, under the lock the write takes.
 *
 * `already_released` is `releaseWorker`'s own kind for the same fact, not a new one -- it is the
 * same sentence a person gets from `release-worker`, and the arm turns it into a `failed` decision
 * with that text on the row. A PERSON may still re-arm the worker by hand: `setRuntimeRoles`
 * carries no such guard, deliberately (`lifecycle.ts`'s `setLifecycle` docblock).
 */
export async function mergeRuntimeRoles(
  slaveId: string,
  adds: readonly string[],
  actor: string,
  origin: 'human' | 'system' = 'human',
): Promise<Result<{ readonly runtimeRoles: readonly string[] }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockedSlave(tx, slaveId)
    if (slave === null) return { refusal: { kind: 'slave_not_found', slaveId } as ControlRefusal }
    // Before the union and before the write, so it is a returned value and never a thrown rollback
    // -- the transaction has written nothing at this point.
    if (slave.releasedAt !== null) {
      return { refusal: { kind: 'already_released', slaveId, at: slave.releasedAt.toISOString() } as ControlRefusal }
    }
    const runtimeRoles = [...slave.runtimeRoles]
    for (const role of adds) {
      const trimmed = role.trim()
      // A blank role is not a role. `actionSchema` already refuses one on the way in
      // (`role: z.string().min(1)`); dropping it here means a hand-edited row cannot write an
      // empty string into a set the scheduler matches on.
      if (trimmed !== '' && !runtimeRoles.includes(trimmed)) runtimeRoles.push(trimmed)
    }
    // The cap `setRuntimeRoles` keeps, before the write (M47 final review, Minor 7). Returned, not
    // thrown: nothing in this transaction has been written yet. The Supervisor's `assign_capability`
    // arm turns the refusal into a `failed` decision, which is the honest record -- the role was
    // not granted, and a human has to take one away before it can be.
    const refusal = overCap(runtimeRoles)
    if (refusal !== null) return { refusal }
    // Both sets only ever grow here, so a length that did not move is a set that did not move --
    // the same reading `hireFromTemplate`'s reuse branch makes.
    const changed = runtimeRoles.length !== slave.runtimeRoles.length
    if (changed) await tx.slave.update({ where: { id: slaveId }, data: { runtimeRoles } })
    return { workspaceId: slave.workspaceId, runtimeRoles, changed }
  })
  if ('refusal' in outcome) return err(outcome.refusal)
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

/** The seat plus the workspace the event needs, under `FOR UPDATE` -- `lockSlave`'s shape from
 *  `org.ts`, re-read here because that helper returns the whole include and this file needs a few
 *  fields. `capabilities` came with the final review's Important 1: `hireFromTemplate`'s reuse
 *  branch merges BOTH sets, and a merge computed off a row read before the lock is the lost update
 *  this helper exists to stop. `releasedAt` came with M50's (Important 1): whether this engagement
 *  is over has to be read under the SAME lock the write takes, or the release and the re-arming
 *  interleave and the worker keeps the role.
 *
 *  M58 R1: both of those are the PERSON's columns now, joined here so every caller keeps reading
 *  one flat row -- and `personId` comes back with them, because the writers write them there.
 *
 *  Which is why the PERSON is locked too (fix round 1, Important 5). Locking the seat alone stopped
 *  being enough the moment `capabilities` moved off it: `hireFromTemplate`'s reuse branch merges
 *  and writes `Person.capabilities` under this lock, `setPersonCapabilities` writes the same column
 *  under a lock on the PERSON, and two seat rows can hold the same person -- so a hire and a
 *  set-capabilities on one person serialised against nothing and one of the two writes was lost.
 *  PERSON FIRST, then the seat. That is the ONE lock order in this package -- `setPersonCapabilities`
 *  below and `releaseWorker` in `lifecycle.ts` both take it -- and taking one order everywhere is
 *  the whole of why none of them can deadlock against each other. `releaseWorker` used to take
 *  seat -> person and did deadlock (40P01) against this branch; fix round 2 hoisted its person lock.
 *  The person is resolved and locked in ONE statement (`FOR UPDATE OF p`), because reading the id
 *  first and locking it second is the very race this is closing. */
async function lockedSlave(
  tx: Prisma.TransactionClient,
  slaveId: string,
): Promise<{
  readonly personId: string
  readonly runtimeRoles: readonly string[]
  readonly capabilities: readonly string[]
  /** Final review, Important 2: the explicit half of this person's capability set, and whether
   *  they are managed at all. The reuse merge below writes both halves for a managed person, and
   *  both have to be read under this same lock for the same reason `capabilities` is. */
  readonly capabilityGrants: readonly string[]
  readonly poolSlot: number | null
  readonly releasedAt: Date | null
  readonly workspaceId: string
} | null> {
  await tx.$queryRaw`SELECT p.id FROM "Person" p JOIN "Slave" s ON s."personId" = p.id WHERE s.id = ${slaveId} FOR UPDATE OF p`
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Slave" WHERE id = ${slaveId} FOR UPDATE`
  if (locked.length === 0) return null
  const row = await tx.slave.findUnique({
    where: { id: slaveId },
    select: {
      personId: true,
      runtimeRoles: true,
      person: { select: { capabilities: true, capabilityGrants: true, poolSlot: true, releasedAt: true } },
      team: { select: { workspaceId: true } },
    },
  })
  return row === null
    ? null
    : {
        personId: row.personId,
        runtimeRoles: row.runtimeRoles,
        capabilities: row.person.capabilities,
        capabilityGrants: row.person.capabilityGrants,
        poolSlot: row.person.poolSlot,
        releasedAt: row.person.releasedAt,
        workspaceId: row.team.workspaceId,
      }
}

/**
 * The cap `setRuntimeRoles` keeps, kept by every OTHER writer of the column too (M47 final review,
 * Minor 7).
 *
 * `setRuntimeRoles` is a replacement and refuses a set over `MAX_RUNTIME_ROLES`; the three writers
 * that UNION -- {@link mergeRuntimeRoles}, {@link setPersonCapabilities} and
 * {@link hireFromTemplate}'s reuse merge -- grew the same column without ever asking, so a worker
 * that provides a dozen capabilities across a dozen domains could end up holding a role set the
 * operator-facing verb would refuse to write and could then no longer edit in one go.
 *
 * The same refusal, word for word, because it is the same invariant and the operator's fix is the
 * same one: take a role away first. Returned BEFORE any write in every caller, so it is a value
 * and never a thrown rollback.
 */
function overCap(roles: readonly string[]): ControlRefusal | null {
  if (roles.length <= MAX_RUNTIME_ROLES) return null
  return {
    kind: 'invalid_runtime_roles',
    reason: `a slave may hold at most ${String(MAX_RUNTIME_ROLES)} runtime roles; this set has ${String(roles.length)}`,
  }
}

/** The taxonomy's WORDS for a set of keys, comma-joined in the keys' own order -- what an
 *  `org.changed { field: 'capabilities' }` payload carries (M47 final review, Minor 5c). The
 *  timeline card renders `from -> to` verbatim, and the key is recoverable from the slave row, so
 *  the event is the one place the two can differ and the words are what a person needs there. */
function capabilityLabels(keys: readonly string[], taxonomy: readonly CapabilityRecord[]): string | null {
  if (keys.length === 0) return null
  return keys.map((key) => capabilityLabel(key, taxonomy)).join(', ')
}

/**
 * ONE person, already working here, onto ONE project (M58 R16) -- the single-seat sibling of
 * `assignCompanyTx`, which seats a whole company.
 *
 * Idempotent on the person: a seat they already hold in this workspace is RETURNED, never doubled,
 * and a seat they held and left is REOPENED (R2) rather than replaced -- which is what keeps their
 * runs, messages and permissions on this project as history.
 *
 * The department is the one their first membership names, found or created from it exactly as
 * `assignCompanyTx` does, so a project staffed one person at a time and one assigned wholesale end
 * up with the same shape. A person who belongs to no department is seated in the workspace's first
 * team by name -- the same fallback `hireFromTemplate` makes, and for the same reason.
 */
export async function seatMember(
  workspaceId: string,
  personId: string,
  opts: {
    readonly rationale?: string
    /** What the seat should DISPATCH as. Omitted -- which is every caller today -- a new seat takes
     *  the person's own role plus the project roles their capabilities project to, and a REOPENED
     *  seat keeps whatever it already had unless that set is empty, in which case the same default
     *  is restored. */
    readonly runtimeRoles?: readonly string[]
  } = {},
): Promise<Result<{ readonly slaveId: string; readonly created: boolean }, ControlRefusal>> {
  const taxonomy = await listCapabilities()
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: {
      template: true,
      departments: { include: { companyTeam: true }, orderBy: { companyTeamId: 'asc' }, take: 1 },
    },
  })
  if (person === null) return err({ kind: 'person_not_found', personId })

  const capabilities = person.capabilities
  const role = person.template?.role ?? 'worker'
  const runtimeRoles = [...new Set(opts.runtimeRoles ?? [role, ...projectRoles(capabilities, taxonomy)])]

  let seated: { readonly id: string; readonly created: boolean } | { readonly refusal: ControlRefusal }
  try {
    seated = await prisma.$transaction(async (tx) => {
      // The workspace row under `FOR UPDATE` before the existence check (fix round 1, minor 2):
      // two callers seating the same person must serialise rather than both read "not there".
      // `assignCompanyTx` locks the same row for the same reason.
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      // Person lock before the first seat write: `releasePerson` stamps `releasedAt` and CLOSES
      // every seat, so a reopen here would undo R21. Same check `assignPerson` already makes.
      await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
      const locked = await tx.person.findUnique({ where: { id: personId }, select: { releasedAt: true } })
      if (locked === null) return { refusal: { kind: 'person_not_found', personId } as ControlRefusal }
      if (locked.releasedAt !== null) {
        return { refusal: { kind: 'person_released', personId, at: locked.releasedAt.toISOString() } as ControlRefusal }
      }
      // An OPEN seat first (fix round 1, Minor 4). One person can hold several seats on one
      // project over time -- one per department they have sat in -- and `orderBy: id` alone would
      // find a CLOSED one and reopen it beside a seat they are already working from, which
      // `listWorkers`' `closedAt: null` then shows twice.
      const open = await tx.slave.findFirst({ where: { personId, team: { workspaceId }, closedAt: null }, orderBy: { id: 'asc' } })
      if (open !== null) return { id: open.id, created: false }
      const closed = await tx.slave.findFirst({ where: { personId, team: { workspaceId }, closedAt: { not: null } }, orderBy: { id: 'asc' } })
      if (closed !== null) {
        // `closedAt` only when the stored roles are still there (fix round 1, Minor 5): a seat's
        // runtime roles are a fact an operator set on THAT seat. An emptied set is the close
        // invariant (`unassignPerson` writes `[]`), so restore the same default a new seat would
        // take -- `[role, ...projectRoles]` -- rather than reopening as undraftable.
        await tx.slave.update({
          where: { id: closed.id },
          data: {
            closedAt: null,
            ...(opts.runtimeRoles !== undefined || closed.runtimeRoles.length === 0 ? { runtimeRoles } : {}),
          },
        })
        return { id: closed.id, created: true }
      }

      const department = person.departments[0]
      const team =
        department === undefined
          ? ((await tx.team.findFirst({ where: { workspaceId }, orderBy: { name: 'asc' } })) ??
            (await tx.team.create({ data: { workspaceId, name: 'Specialists' } })))
          : (await departmentFor(tx, workspaceId, department.companyTeam)).team
      const seat = await tx.slave.create({ data: { teamId: team.id, personId, role, runtimeRoles } })
      // R6: the sentence WHY they are here, written once. A person seated a second time keeps the
      // sentence the first seating recorded -- that is the answer to "why is this person here".
      if (opts.rationale !== undefined && person.selectionRationale === null) {
        await tx.person.update({ where: { id: personId }, data: { selectionRationale: opts.rationale } })
      }
      return { id: seat.id, created: true }
    })
  } catch (error) {
    // `departmentFor`'s one post-write refusal, unwrapped exactly as `assignCompany` unwraps it.
    if (error instanceof AssignmentRefused) return err(error.refusal)
    throw error
  }

  if ('refusal' in seated) return err(seated.refusal)
  if (!seated.created) return ok({ slaveId: seated.id, created: false })

  await appendEvent({
    type: 'org.changed',
    workspaceId,
    slaveId: seated.id,
    actor: 'system',
    payload: { entity: 'slave', id: seated.id, personId, field: 'created', from: null, to: person.name },
  })
  return ok({ slaveId: seated.id, created: true })
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
 * A RELEASED person is never reused (M50 R2): their engagement is over, their runtime roles are
 * empty on purpose, and merging a new hire into them would quietly un-retire somebody. The reuse
 * read therefore requires `releasedAt: null`, and a hire that finds only released copies creates a
 * new person -- which `uniquePersonName` names `<Name> 2`, because the released one still holds
 * `<Name>` and nothing deleted them.
 *
 * A reuse NEVER rewrites `lifecycle` or `engagementTaskId` (M50 R4, plan erratum E13). Only
 * `setLifecycle` moves a lifecycle after creation, so a temporary hire landing on a worker created
 * `project` merges capabilities and roles and leaves the worker what it was. The claim stays true
 * of the decision; the worker keeps what it was created as.
 *
 * Catalog Person Pool (Task 4): when nobody from this persona is ALREADY on the project (the
 * `existing` branch above found nothing), this no longer reaches straight for `createPerson`'s own
 * shape -- it asks `selectPoolPerson` for one of the template's three managed people first, the
 * same call `intake.ts`'s `staff` step makes, so the two staffing paths cannot diverge into two
 * different answers for "who is free". A pool with nothing eligible is synced once
 * (`syncPersonPool`) and selection is retried once, exactly `intake.ts`'s own rule. Only when that
 * retry also comes up empty does this fall back to minting a brand-new, unmanaged `Person` -- and
 * only when {@link requirePool} is not set: automatic supervisor/catalogue staffing
 * (`carryOut`'s `hire_from_catalog`, `supervisor.ts`) sets it, so a pool that has run out FAILS
 * that hire with the same `pool_unavailable` refusal rather than quietly growing the roster by one
 * unmanaged person nobody chose to add; the CLI's explicit `hire` leaves it unset and keeps the
 * old on-demand-creation compatibility.
 *
 * **The sync happens only after the transaction has ruled reuse out** (final review, Important 5).
 * The pool CANDIDATE is still read before the transaction opens -- it names no row this
 * transaction has a reason to lock until it decides to seat them, and moving `existing`'s read out
 * from behind the workspace lock would reopen the double-hire race fix round 1 closed. But the
 * `syncPersonPool()` that followed a `pool_unavailable` candidate read used to run BEFORE any of
 * that: every repeat hire on the reuse path -- which E10 says one supervised pass can produce --
 * walked every active template in the catalogue and wrote three people for each that was short, to
 * answer a question it then discarded. So this is at most TWO attempts: candidate read plus
 * transaction, where an existing seat wins with no sync at all; and only if that transaction
 * reports it found no reusable seat AND no usable candidate, ONE sync outside the transaction, one
 * reselect, and one retry. `requirePool`'s refusal and the manual fallback are decided on that
 * second attempt.
 *
 * **The department is the role's** (final review, Important 1). This used to seat into
 * `teams[0]` -- the project's first department by name -- which is alphabetical chance on any
 * project with more than one. `intake.ts`'s staff step files seats by
 * `functionalDepartmentFor(role, runtimeRoles)`, so a project staffed from the catalogue had real
 * functional departments and the first supervisor hire after it landed in whichever one sorted
 * first. Same function, same arguments, so the two staffing paths cannot disagree about where a
 * backend specialist belongs. `Specialists` is still the fallback -- it is what that function
 * returns for a role the table does not recognise.
 *
 * **A hire that seats nobody creates no department** (fix round 2, gap 5). That find-or-create used
 * to run at the top of the create branch, before the candidate had been re-verified under its own
 * lock -- and a value RETURNED from an interactive `$transaction` commits everything written before
 * it. So the two branches that hire nobody, `needs_pool` for a candidate that raced away and the
 * `requirePool` refusal after it, left an empty `Team` behind on a project that had no departments at
 * all. The department is materialised at the last moment on each path that is about to write a seat,
 * and a department this verb DID create is announced with the same
 * `org.changed { entity: 'team', field: 'created' }` `createProjectTeam` writes -- once, and never
 * for one it merely reused.
 */
export async function hireFromTemplate(
  workspaceId: string,
  templateId: string,
  opts: {
    readonly capabilities?: readonly string[]
    readonly rationale: string
    /** M50 R2: this hire is for ONE assignment. The worker is created `ephemeral` and
     *  {@link engagementTaskId} is what `engagement_over` later measures the end against. */
    readonly temporary?: boolean
    /** M50 R2: the assignment. REQUIRED when `temporary` is true -- a temporary worker with no
     *  engagement is one nothing can ever release (plan decision D3) -- and validated against this
     *  workspace's own tasks, because the column is a foreign key and a dangling one would throw a
     *  P2003 out of a `Promise<Result<…>>` with nowhere to put it. */
    readonly engagementTaskId?: string | null
    /** Catalog Person Pool Task 4: refuses this hire with `pool_unavailable` instead of falling
     *  back to `createPerson` when the managed pool has nothing eligible even after one sync and
     *  retry. Unset -- the CLI's default -- keeps today's on-demand creation. */
    readonly requirePool?: boolean
  },
): Promise<
  Result<
    {
      readonly slaveId: string
      /** M58: the PERSON the seat belongs to. A caller that wants to give them a skill, a
       *  department or a second seat needs the person, and only this verb knows which one it
       *  created or reused. */
      readonly personId: string
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
  // M50 R1: the rationale is the SENTENCE now and nothing else. It used to carry
  // `(asked for as a temporary specialist)` because a column nothing released would have been a
  // promise the system could not keep; the column exists, so the promise is the record.
  const rationale = opts.rationale
  const temporary = opts.temporary === true
  const engagementTaskId = temporary ? (opts.engagementTaskId ?? null) : null
  if (temporary) {
    // Reported as "no such task" from this caller's side of the boundary -- `decision_not_found`'s
    // rule: a task in another project must read back exactly like one that never existed.
    const engagement =
      engagementTaskId === null
        ? null
        : await prisma.task.findFirst({ where: { id: engagementTaskId, workspaceId }, select: { id: true } })
    if (engagement === null) return err({ kind: 'task_not_found', taskId: engagementTaskId ?? '' })
  }

  // Task 4: a managed candidate for this workspace, looked up BEFORE the transaction below --
  // `selectPoolPerson` is a plain read, exactly like `intake.ts`'s own staff step -- so the
  // transaction only ever re-validates one specific personId under lock rather than running the
  // whole ranked query while holding the workspace row. This read runs unconditionally, even on
  // the well-worn "already hired from this template" path below that never ends up using it: the
  // alternative -- deciding whether to look AFTER the workspace lock decides "nothing existing" --
  // would move `existing`'s own read out from behind that lock too, and two concurrent hires for a
  // template with nothing on the project yet would both compute "nothing existing" before either
  // took the lock and both create a worker (exactly the race fix round 1 minor 2 closed).
  // `existing` stays inside the lock, unchanged; only the pool lookup moves out, because it names
  // no row this transaction has any reason to lock until it has decided the candidate is actually
  // going to be seated.
  //
  // The SYNC is what moved (final review, Important 5): it is no longer part of this read at all.
  // A `pool_unavailable` answer here is carried into the transaction as "no candidate", and only a
  // transaction that reports it found no reusable seat either earns the one sync below.
  const firstSelection = await selectPoolPerson(templateId, workspaceId)

  /**
   * One attempt: the workspace lock, the reuse decision, and the write it implies (fix round 1,
   * minor 2). Nothing indexes "somebody in this workspace from this persona", so without that lock
   * two approvals of the same proposal -- which is exactly what E10 says one supervised pass can
   * produce -- would both read "nobody hired yet" and put two copies of one specialist on the
   * project.
   *
   * `last` is what makes this at most two attempts rather than a loop. On the FIRST attempt, a
   * transaction that finds neither a reusable seat nor a usable candidate returns `needs_pool` and
   * writes nothing: the caller syncs once, reselects, and runs this again. On the SECOND, the same
   * situation is final, and `requirePool`'s refusal or the unmanaged fallback is applied.
   */
  const attempt = async (poolCandidateId: string | null, poolRefusal: ControlRefusal | null, last: boolean) =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      const existing = await tx.slave.findFirst({
        // M58 R2: an OPEN seat held by somebody hired from this persona. `releasedAt: null` (M50
        // R2): a released person's engagement is over and nothing re-hires them.
        where: { person: { templateId, releasedAt: null }, team: { workspaceId }, closedAt: null },
        orderBy: { id: 'asc' },
      })
      if (existing !== null) {
        // The Slave row under `FOR UPDATE`, and the merge computed off THAT read (M47 final review,
        // Important 1). The workspace lock above serialises this branch against another hire; it does
        // NOT serialise it against `setRuntimeRoles`, `setPersonCapabilities` or `mergeRuntimeRoles`,
        // every one of which locks the Slave row alone. A `set-runtime-roles` landing between the
        // `findFirst` above and the update below was overwritten by a union computed from a row read
        // before it -- the role the operator had just granted silently gone. Lock order is
        // Workspace -> Slave, the order `seatMember` and `assignCompanyTx` also take,
        // so two of these can never deadlock against each other.
        const locked = await lockedSlave(tx, existing.id)
        // The worker was deleted between the two reads inside this transaction. Nothing is written,
        // so this is a returned refusal; the caller may hire again and will create one.
        if (locked === null) return { kind: 'vanished' as const, slaveId: existing.id }
        // Fix round 2: `existing` was read with `releasedAt: null` above, but that read takes NO lock
        // and a concurrent `releaseWorker` can release this very person before `lockedSlave`'s own
        // lock is granted -- `releaseWorker` now locks the person FIRST too (the shared order this
        // docstring names), so the two transactions never deadlock, but ONE of them still runs
        // second, and if that one is the release, this reuse's own eligibility read is stale.
        // Re-checked under the lock this file's own docstring on `lockedSlave` promises: without it,
        // `runtimeRoles` below -- computed from `template.role` plus every capability THIS call
        // wants, not from what the seat currently holds -- would re-arm a person who was just
        // released with the very roles their release just emptied. A released person names no
        // eligible seat, which is exactly the outcome an unraced call gets from the `releasedAt: null`
        // filter above; falling through to the create branch below gives a raced call the same one.
        if (locked.releasedAt === null) {
          const merged = [...new Set([...locked.capabilities, ...capabilities])].toSorted()
          const roles = [...locked.runtimeRoles]
          for (const role of runtimeRoles) if (!roles.includes(role)) roles.push(role)
          // Both sets only ever grow here, so a length that did not move is a set that did not move.
          const rolesChanged = roles.length !== locked.runtimeRoles.length
          const capabilitiesChanged = merged.length !== locked.capabilities.length
          // The cap, before the write and before anything else in this transaction has written either
          // (M47 final review, Minor 7).
          const refusal = overCap(roles)
          if (refusal !== null) return { kind: 'refused' as const, refusal }
          // M58 R1: the capabilities are the PERSON's and the runtime roles are the SEAT's, so the
          // one merge lands in two rows.
          if (capabilitiesChanged) {
            await tx.person.update({
              where: { id: locked.personId },
              // Final review, Important 2: what this hire asked for BEYOND the persona is an
              // explicit grant, so the next pool sync keeps it. The baseline is subtracted first,
              // which is what stops today's `capabilityKeys` being frozen into the grant column and
              // deafening this person to every later template edit. Written only for a MANAGED
              // person -- an unmanaged one has no baseline, and `capabilities` is their whole
              // answer, exactly as before.
              data: {
                capabilities: merged,
                ...(locked.poolSlot === null
                  ? {}
                  : {
                      capabilityGrants: [
                        ...new Set([...locked.capabilityGrants, ...capabilityGrantDelta(asked, template.capabilityKeys)]),
                      ].toSorted(),
                    }),
              },
            })
          }
          if (rolesChanged) await tx.slave.update({ where: { id: existing.id }, data: { runtimeRoles: roles } })
          return {
            kind: 'reused' as const,
            slaveId: existing.id,
            personId: locked.personId,
            capabilities: merged,
            runtimeRoles: roles,
            before: locked.capabilities,
            rolesChanged,
            capabilitiesChanged,
          }
        }
      }

      // Nothing already seated from this template can be reused, and there is no usable candidate
      // either (a missing pool, or every managed person released or already on this workspace).
      //
      // On the FIRST attempt that is not an answer yet, it is the ONE situation that earns a sync
      // (final review, Important 5): this transaction has established, under the workspace lock,
      // that reuse is off the table, which is precisely the thing the old unconditional pre-sync
      // could not know. Nothing has been written, so returning here rolls nothing back.
      if (poolCandidateId === null && !last) return { kind: 'needs_pool' as const }

      // `requirePool` refuses right here rather than reaching the on-demand create below.
      if (poolCandidateId === null && opts.requirePool === true) {
        return { kind: 'refused' as const, refusal: poolRefusal ?? ({ kind: 'pool_unavailable', templateId } as ControlRefusal) }
      }

      // A hire needs a department, and it is the one the ROLE belongs in (final review, Important
      // 1) -- `functionalDepartmentFor`, the same function and the same arguments `intake.ts`'s
      // staff step uses, so a project staffed from the catalogue and one grown a hire at a time
      // file a backend specialist in the same place. This used to take the project's first
      // department BY NAME, which is alphabetical chance the moment a project has two. The
      // fallback is unchanged in effect: that function answers `Specialists` for a role its table
      // does not recognise, which is the name this branch has always used.
      //
      // NAMED here, WRITTEN below (fix round 2, gap 5): the find-or-create used to run at this point,
      // before the candidate had been re-verified under its own lock, and the two branches that
      // return without seating anybody -- `needs_pool` for a candidate that raced away, and the
      // `requirePool` refusal after it -- COMMIT whatever this transaction wrote before them. A
      // refused hire therefore left an empty `Engineering` on a project that had no departments at
      // all: visible in the Organization view, in the sidebar and to `formTeam`, created by a hire
      // that was refused and removed by nothing. So the department is materialised at the last
      // moment, on each path that is actually about to create a seat, and `created` is carried out so
      // the caller can put it on the timeline.
      const department = functionalDepartmentFor(template.role, runtimeRoles)
      const ensureDepartment = async (): Promise<{ readonly id: string; readonly created: boolean }> => {
        const found = await tx.team.findFirst({ where: { workspaceId, name: department }, select: { id: true } })
        if (found !== null) return { id: found.id, created: false }
        // Safe to create unguarded: the `Workspace` row is held `FOR UPDATE` above and every other
        // writer of `(workspaceId, name)` takes that same lock first (final review fix round 2,
        // Important A, `org.ts`'s `lockWorkspaceForDepartmentName`), so nothing can be racing this.
        const made = await tx.team.create({ data: { workspaceId, name: department }, select: { id: true } })
        return { id: made.id, created: true }
      }

      // Task 4: seat the managed candidate `selectPoolPerson` chose before this transaction opened,
      // instead of minting a new `Person` below. PERSON locked FIRST, directly by id -- this file's
      // one lock order (`lockedSlave`'s own docstring above) -- since no `Slave` row names them yet
      // for a join to lock through.
      if (poolCandidateId !== null) {
        await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${poolCandidateId} FOR UPDATE`
        const pooled = await tx.person.findUnique({ where: { id: poolCandidateId } })
        // Re-verified under the lock, exactly `lockedSlave`'s own reason: the candidate may have
        // been released, or seated here by a concurrent hire that reached the workspace lock first,
        // between `selectPoolPerson`'s read above and this one.
        const busyHere =
          pooled !== null &&
          (await tx.slave.findFirst({
            where: { personId: pooled.id, team: { workspaceId }, closedAt: null },
            select: { id: true },
          })) !== null
        if (pooled !== null && pooled.releasedAt === null && !busyHere) {
          const team = await ensureDepartment()
          const merged = [...new Set([...pooled.capabilities, ...capabilities])].toSorted()
          // The rationale is written here exactly as it is for a brand-new hire (below): this pool
          // person is NEW to this project, and "why they are here" is this call's own sentence, not
          // whatever the pool held (nothing, today -- `syncPersonPool` never sets it) or whatever
          // another project's earlier hire wrote. A worker ALREADY on this project instead goes
          // through the `existing` reuse branch above, which never touches a rationale that is
          // already true.
          //
          // The grant column moves with it (final review, Important 2): only what this hire asked
          // for over and above the persona, so a supervisor hire made to close a genuine capability
          // gap survives the next sync while the persona's own keys stay the persona's.
          await tx.person.update({
            where: { id: pooled.id },
            data: {
              capabilities: merged,
              selectionRationale: rationale,
              ...(pooled.poolSlot === null
                ? {}
                : {
                    capabilityGrants: [
                      ...new Set([...pooled.capabilityGrants, ...capabilityGrantDelta(asked, template.capabilityKeys)]),
                    ].toSorted(),
                  }),
            },
          })
          const worker = await tx.slave.create({
            data: { teamId: team.id, personId: pooled.id, role: template.role, runtimeRoles, engagementTaskId },
          })
          return {
            kind: 'created' as const,
            slaveId: worker.id,
            name: pooled.name,
            personId: pooled.id,
            team: { id: team.id, name: department, created: team.created },
          }
        }
        // The chosen candidate raced away. On the first attempt that is another "nothing usable,
        // and reuse is ruled out" -- the sync/reselect below is bounded at one, so a raced
        // candidate gets the same single retry a missing pool does rather than a special case.
        if (!last) return { kind: 'needs_pool' as const }
        // `requirePool` refuses outright rather than falling through to the unmanaged create below
        // it was set to prevent; the CLI's on-demand path (`requirePool` unset) takes that fallback
        // exactly as it did before this task.
        if (opts.requirePool === true) {
          return { kind: 'refused' as const, refusal: { kind: 'pool_unavailable', templateId } as ControlRefusal }
        }
      }

      // M58 R1: a hire creates a PERSON and then a seat for them. Two writes in one transaction, so
      // a person with no seat is never left behind by a half-applied hire. The name is unique across
      // the INSTALLATION now, which is why `uniquePersonName` reads every person and not this
      // workspace's workers. `lifecycle`, `capabilities` and the rationale are facts about the
      // person; `role` and `runtimeRoles` are facts about the seat.
      //
      // The department is materialised HERE, on the last path that can still refuse (fix round 2, gap
      // 5): every branch above that returns without a seat has already returned, so a `Team` written
      // from this point on always ends up with somebody in it.
      const manualTeam = await ensureDepartment()
      const person = await tx.person.create({
        data: {
          name: uniquePersonName(await tx.person.findMany({ select: { name: true } }), template.name),
          templateId,
          capabilities,
          selectionRationale: rationale,
          lifecycle: temporary ? 'ephemeral' : 'project',
        },
      })
      const worker = await tx.slave.create({
        data: { teamId: manualTeam.id, personId: person.id, role: template.role, runtimeRoles, engagementTaskId },
      })
      return {
        kind: 'created' as const,
        slaveId: worker.id,
        name: person.name,
        personId: person.id,
        team: { id: manualTeam.id, name: department, created: manualTeam.created },
      }
    })

  // Attempt one: no sync has run, and an existing seat wins here without one.
  const first = await attempt(
    firstSelection.ok ? firstSelection.value.personId : null,
    firstSelection.ok ? null : firstSelection.error,
    false,
  )
  // Attempt two, and there is no third: one sync, one reselect, one retry, then the refusal or the
  // fallback. `last` is `true`, so this call cannot ask for another.
  let outcome = first
  if (first.kind === 'needs_pool') {
    await syncPersonPool()
    const again = await selectPoolPerson(templateId, workspaceId)
    outcome = await attempt(again.ok ? again.value.personId : null, again.ok ? null : again.error, true)
  }
  // Unreachable: the only producer of `needs_pool` is guarded by `!last`, and the retry above
  // passes `last: true`. Narrowed rather than asserted, so the compiler carries the proof.
  if (outcome.kind === 'needs_pool') return err({ kind: 'pool_unavailable', templateId })

  if (outcome.kind === 'vanished') return err({ kind: 'slave_not_found', slaveId: outcome.slaveId })
  if (outcome.kind === 'refused') return err(outcome.refusal)
  if (outcome.kind === 'created') {
    // The DEPARTMENT first, when this hire is what made it (fix round 2, gap 5), in the order the two
    // things happened. `createProjectTeam`'s payload verbatim -- same entity, same field, same
    // from/to -- so the Activity card that already renders a department creation renders this one and
    // a department that appeared because the Supervisor hired a backend specialist is on the timeline
    // rather than out of nowhere. `actor: 'system'`, matching the seat event below it: this verb is
    // reached from `carryOut`'s `hire_from_catalog` arm and from the CLI, never from a principal
    // `createProjectTeam` could name. Nothing at all for a department it merely reused.
    if (outcome.team.created) {
      await appendEvent({
        type: 'org.changed',
        workspaceId,
        actor: 'system',
        payload: { entity: 'team', id: outcome.team.id, field: 'created', from: null, to: outcome.team.name },
      })
    }
    await appendEvent({
      type: 'org.changed',
      workspaceId,
      slaveId: outcome.slaveId,
      actor: 'system',
      payload: { entity: 'slave', id: outcome.slaveId, personId: outcome.personId, field: 'created', from: null, to: outcome.name },
    })
    return ok({ slaveId: outcome.slaveId, personId: outcome.personId, reused: false, capabilities, runtimeRoles })
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
      // LABELS, not keys (M47 final review, Minor 5c): the timeline card renders `from -> to`
      // verbatim at a person, and the keys are recoverable from the slave row this event names.
      payload: {
        entity: 'slave',
        id: outcome.slaveId,
        field: 'capabilities',
        from: capabilityLabels([...outcome.before].toSorted(), taxonomy),
        to: capabilityLabels(outcome.capabilities, taxonomy),
      },
    })
  }
  return ok({
    slaveId: outcome.slaveId,
    personId: outcome.personId,
    reused: true,
    capabilities: outcome.capabilities,
    runtimeRoles: outcome.runtimeRoles,
  })
}

/**
 * What every worker who PREDATES M47 provides, read off the template it already came from (M47
 * final review, Important 4).
 *
 * `Person.capabilities` is `@default([])` and nothing backfilled it, so on any project that existed
 * before this milestone the column is empty on every row -- and `formTeam`'s FIRST tier, "somebody
 * already here who can do it and was never given the role", is the one that reads it. The tier is
 * not wrong; it is dead, and every gap on a real project skips straight past the cheapest fix to a
 * hire a human has to answer. This verb is that fix, run once per project.
 *
 * ONLY a PERSON whose own capability set is EMPTY, and only from the persona they are already
 * linked to (`Person.templateId`, M58 R1). Somebody an operator has already described with
 * `set-capabilities` is never touched: that set is a human's answer and this verb has nothing
 * better. Somebody with no persona is skipped -- there is nothing to read.
 *
 * Roles are UNIONED, never replaced, for the reason `setPersonCapabilities` unions them: taking a
 * role away as a side effect of describing a skill parks a worker mid-project. Each worker is read
 * and written under its own `FOR UPDATE`, one transaction each rather than one for the lot: a
 * project-wide lock held across hundreds of rows would block every tick for as long as it ran, and
 * a partial backfill is a correct backfill -- re-running finishes it.
 *
 * `workspaceId` narrows it to one project; absent, it is every project in the installation.
 */
export async function backfillSlaveCapabilities(
  workspaceId?: string,
): Promise<{ readonly updated: number; readonly skipped: number }> {
  const taxonomy = await listCapabilities()
  const persons = await prisma.person.findMany({
    where: {
      capabilities: { isEmpty: true },
      ...(workspaceId === undefined ? {} : { seats: { some: { team: { workspaceId }, closedAt: null } } }),
    },
    select: {
      template: { select: { capabilityKeys: true } },
      seats: {
        where: { closedAt: null, ...(workspaceId === undefined ? {} : { team: { workspaceId } }) },
        select: { id: true },
        orderBy: { id: 'asc' },
      },
    },
    orderBy: { id: 'asc' },
  })
  // One entry per SEAT, the unit this verb has always counted and evented on -- a person with two
  // open seats is two rows here, and the second one's re-read under the lock finds their
  // capabilities already written and reports it skipped.
  const rows = persons.flatMap((person) =>
    person.seats.map((seat) => ({ id: seat.id, keys: person.template?.capabilityKeys ?? [] })),
  )

  let updated = 0
  let skipped = 0
  for (const row of rows) {
    const keys = row.keys
    if (keys.length === 0) {
      skipped += 1
      continue
    }
    const outcome = await prisma.$transaction(async (tx) => {
      const slave = await lockedSlave(tx, row.id)
      // Re-read under the lock: `set-capabilities` may have described this person between the scan
      // above and this transaction, and that answer is a human's.
      if (slave === null || slave.capabilities.length > 0) return null
      const runtimeRoles = [...slave.runtimeRoles]
      for (const role of projectRoles(keys, taxonomy)) if (!runtimeRoles.includes(role)) runtimeRoles.push(role)
      // The cap is an invariant, not a preference: a worker whose persona would carry it past
      // `MAX_RUNTIME_ROLES` keeps the roles it has and is reported as skipped, rather than being
      // written into a state `set-runtime-roles` would refuse to write.
      if (overCap(runtimeRoles) !== null) return null
      await tx.person.update({ where: { id: slave.personId }, data: { capabilities: [...keys] } })
      await tx.slave.update({ where: { id: row.id }, data: { runtimeRoles } })
      return { workspaceId: slave.workspaceId }
    })
    if (outcome === null) {
      skipped += 1
      continue
    }
    // ONE event per worker actually changed -- in LABELS, like every other `capabilities` write
    // (Minor 5c). `from` is null because the whole predicate of this verb is that there was nothing
    // there.
    await appendEvent({
      type: 'org.changed',
      workspaceId: outcome.workspaceId,
      slaveId: row.id,
      actor: 'human',
      payload: {
        entity: 'slave',
        id: row.id,
        field: 'capabilities',
        from: null,
        to: capabilityLabels(keys, taxonomy),
      },
    })
    updated += 1
  }
  return { updated, skipped }
}

/** `Name`, then `Name 2`, `Name 3`… -- the installation may already have somebody with the
 *  persona's name, and `Person.name` is unique across it (M58 R1). Deterministic and readable,
 *  which a uuid suffix would not be. Exported since M58: `createPerson` resolves a collision by the
 *  same rule, and two rules would eventually disagree. */
export function uniquePersonName(existing: readonly { readonly name: string }[], wanted: string): string {
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
  /** M58 R2: the person sitting in this seat. The identity every other surface joins on. */
  readonly personId: string
  readonly name: string
  readonly role: string
  readonly runtimeRoles: readonly string[]
  readonly capabilities: readonly string[]
  /** M50 R1: WHY this person is here, off `Person.lifecycle` (M58 R1). Replaces the
   *  `companySlaveId === null ? 'project' : 'company'` derivation this interface carried until
   *  M50 -- one of three readings of one question, none of which could say "temporary". */
  readonly lifecycle: SlaveLifecycle
  /** M50 R3: the engagement is over. `at` is an ISO string, never a `Date` -- this view crosses a
   *  server/client boundary. Null for every worker still here. */
  readonly released: { readonly at: string; readonly reason: string } | null
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
    // M58 R17: OPEN seats only. A closed seat keeps its history and is nobody on this project.
    where: { team: { workspaceId }, closedAt: null },
    orderBy: { person: { name: 'asc' } },
    include: {
      person: {
        include: {
          template: { select: { id: true, name: true } },
          departments: { include: { companyTeam: { include: { company: { select: { name: true } } } } }, orderBy: { companyTeamId: 'asc' }, take: 1 },
        },
      },
      // `NON_TERMINAL_RUN_STATUSES`, the repository's one list of "this run is still going"
      // (`supervisorWorld.ts`'s roster read uses the same one) -- never a hand-written status list
      // here, which would drift from the enum the moment a status is added.
      runs: { where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } }, select: { id: true }, take: 1 },
    },
  })

  const templateBySlave = new Map(
    rows.flatMap((row) => (row.person.templateId === null ? [] : [[row.id, row.person.templateId] as const])),
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
      personId: row.personId,
      name: row.person.name,
      role: row.role,
      runtimeRoles: row.runtimeRoles,
      capabilities: row.person.capabilities,
      lifecycle: row.person.lifecycle,
      released:
        row.person.releasedAt === null
          ? null
          : { at: row.person.releasedAt.toISOString(), reason: row.person.releaseReason ?? 'released' },
      companyName: row.person.departments[0]?.companyTeam.company.name ?? null,
      hiredFromTemplateId: row.person.template?.id ?? null,
      hiredFromTemplateName: row.person.template?.name ?? null,
      selectionRationale: row.person.selectionRationale,
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
