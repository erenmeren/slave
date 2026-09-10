import { createHash } from 'node:crypto'
import { Prisma, prisma } from '@slave-of-ai/db/client'
import {
  PROFILE_MAX_CHARS,
  PROFILE_OVERRIDABLE_FIELDS,
  effectiveProfileSpec,
  err,
  goalSha256,
  ok,
  overriddenFields,
  profileOverridesSchema,
  profileSpecSchema,
  renderProfileSpec,
  type ProfileOverridableField,
  type ProfileOverrides,
  type Result,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { lockSlave } from './org.js'
import type { ControlRefusal } from './refusal.js'

/**
 * How many roles one worker may be dispatchable as.
 *
 * Not a scaling limit -- twenty roles is far past anything an organisation of this shape has -- but
 * a typo limit: `set-runtime-roles --roles` splits on commas, and a paste of the wrong text would
 * otherwise write a hundred one-word "roles" that quietly make the worker a candidate for
 * everything. The refusal names the number, so an operator who genuinely wants more knows what
 * to argue with.
 */
export const MAX_RUNTIME_ROLES = 20

/**
 * Which row of the profile override chain to write (M37 §2, §6).
 *
 * Three levels, because the chain `effectiveProfile` walks has three: the worker's own column, its
 * roster row's, and its template's. A union rather than three optional fields so "exactly one" is
 * true by construction and there is no ambiguous call to refuse.
 */
export type ProfileTarget =
  | { readonly slaveId: string }
  | { readonly templateId: string }
  | { readonly companySlaveId: string }

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * The one normalisation of a profile text on the way in.
 *
 * Trim first, then measure: a paste with a trailing newline is not "over the cap by one", and the
 * text that gets STORED is the trimmed one, so the cap must be about that. Whitespace-only (and an
 * explicit `null`) both mean cleared, written as `null` rather than `''` -- `effectiveProfile`
 * treats an empty string as "cleared at this level", which is the same outcome, but only `null`
 * lets the level BELOW show through, and "clear my override" is what an operator means.
 */
function normaliseProfile(profile: string | null): Result<string | null, ControlRefusal> {
  if (profile === null) return ok(null)
  const trimmed = profile.trim()
  if (trimmed === '') return ok(null)
  if (trimmed.length > PROFILE_MAX_CHARS) {
    return err({ kind: 'profile_too_long', limit: PROFILE_MAX_CHARS, length: trimmed.length })
  }
  return ok(trimmed)
}

/**
 * Sets (or clears) the persona Markdown at one level of the override chain (M37 §6).
 *
 * The one way a profile ever changes: spec §1 forbids model output from writing one, so there is
 * no run-scoped path into this and `actor` is a human's name rather than anything derived from a
 * run.
 *
 * **Why only a slave target emits an event** (spec erratum E3). `ExecutionEvent.workspaceId` is
 * NOT NULL and every reader of the log is workspace-scoped, but a `SlaveTemplate` and a
 * `CompanySlave` belong to the CATALOG -- one template can be materialised into workers in any
 * number of projects, and a company is assigned to workspaces rather than owned by one. There is
 * no workspace to write those rows against and no org-level stream to write them to, so the verb
 * writes the column and stays quiet rather than inventing a workspace for the event. The gap is
 * real and is named here so it is not mistaken for an oversight.
 *
 * Not refused while the slave holds a live run, unlike `setSlaveRole`: a run's prompt is assembled
 * once, at dispatch, and recorded in its own `RunContext` row, so a profile written mid-run cannot
 * change what the running model was told. It takes effect at the next dispatch, which is what an
 * operator editing a persona expects.
 */
export async function setProfile(
  target: ProfileTarget,
  profile: string | null,
  actor: string,
): Promise<Result<void, ControlRefusal>> {
  const normalised = normaliseProfile(profile)
  if (!normalised.ok) return normalised
  const text = normalised.value

  // `updateMany` and its count, not `findUnique` then `update` -- `setSlaveModel`'s idiom
  // (`org.ts`): one statement, so a row deleted between the two reads is a clean refusal rather
  // than a Prisma `P2025` nobody catches. These two levels emit nothing, so nothing else is
  // needed from the row.
  if ('templateId' in target) {
    const written = await prisma.slaveTemplate.updateMany({ where: { id: target.templateId }, data: { profile: text } })
    if (written.count === 0) return err({ kind: 'template_not_found', templateId: target.templateId })
    return ok(undefined)
  }

  if ('companySlaveId' in target) {
    const written = await prisma.companySlave.updateMany({
      where: { id: target.companySlaveId },
      data: { profile: text },
    })
    if (written.count === 0) return err({ kind: 'company_slave_not_found', companySlaveId: target.companySlaveId })
    return ok(undefined)
  }

  // A slave target needs its workspace for the event, so the read and the write go in one
  // transaction -- `setSlaveRole`'s shape, through `lockSlave` itself (final review). The plain
  // `findUnique` this used to open with left a window: a slave deleted between the two statements
  // made the `update` throw a Prisma `P2025` that nothing catches, which the web layer serves as a
  // 500 where the `slave_not_found` 404 below belongs. `SELECT ... FOR UPDATE` closes it. The
  // refusal is returned from the callback rather than thrown because nothing has been written when
  // it is reached; a refusal AFTER a write in here would have to throw, or the transaction would
  // commit.
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, target.slaveId)
    if (slave === null) return null
    await tx.slave.update({ where: { id: target.slaveId }, data: { profile: text } })
    return { workspaceId: slave.team.workspaceId }
  })
  if (outcome === null) return err({ kind: 'slave_not_found', slaveId: target.slaveId })

  await appendEvent({
    type: 'slave.profile_changed',
    workspaceId: outcome.workspaceId,
    slaveId: target.slaveId,
    actor: 'human',
    payload: {
      target: 'slave',
      targetId: target.slaveId,
      // The hash of what is now STORED, computed exactly as `buildRunContext`'s manifest computes
      // it, so an operator can match "the profile changed here" against "this run saw that text".
      sha256: text === null ? null : sha256(text),
      actor,
    },
  })
  return ok(undefined)
}

/**
 * The one normalisation of a runtime role set, and the three ways it is refused.
 *
 * Trimmed entry by entry, because the CLI's `--roles a, b` splits on the comma and leaves the
 * space. A blank entry and a duplicate are both refused rather than dropped: silently discarding
 * part of what an operator typed is how a worker ends up dispatchable as something nobody meant,
 * and the operator never sees the difference between what they asked for and what was written.
 *
 * An EMPTY set is not a refusal. It is the parked state spec §7 names -- never a scheduler
 * candidate, never staffed, never a role-addressed message's recipient -- and this verb is the
 * only way into and out of it.
 */
function normaliseRoles(roles: readonly string[]): Result<string[], ControlRefusal> {
  if (roles.length > MAX_RUNTIME_ROLES) {
    return err({
      kind: 'invalid_runtime_roles',
      reason: `a slave may hold at most ${String(MAX_RUNTIME_ROLES)} runtime roles; this set has ${String(roles.length)}`,
    })
  }
  const normalised: string[] = []
  for (const role of roles) {
    const trimmed = role.trim()
    if (trimmed === '') {
      return err({ kind: 'invalid_runtime_roles', reason: 'a role must be a non-empty text' })
    }
    if (normalised.includes(trimmed)) {
      return err({ kind: 'invalid_runtime_roles', reason: `"${trimmed}" is named twice` })
    }
    normalised.push(trimmed)
  }
  return ok(normalised)
}

/**
 * Replaces the set of roles a slave may be DISPATCHED as (M37 §5, §6).
 *
 * Since M37 this is the only thing the scheduler (`decide`), the reviewer and manager staffing
 * queries (`review.ts`, `planning.ts`) and role-addressed messaging match on -- `Slave.role` is the
 * profile's title and is matched by nothing. Which makes this verb, and the CLI's
 * `set-runtime-roles`, the only way a worker becomes dispatchable at all.
 *
 * A replacement, not a merge: an operator naming two roles means the worker holds exactly those
 * two afterwards. Anything else would make "take reviewer away from Maya" impossible to express.
 *
 * `actor` and `origin` are two different facts (M38 t2, spec erratum E4). `actor` is the NAME of
 * whoever asked, carried in the payload, and the Supervisor's staffing decisions pass
 * `'supervisor'` there. `origin` is the event ENVELOPE actor, which is a closed enum with no
 * `supervisor` member -- so a Supervisor-applied change says `'system'`, and everything else says
 * `'human'`. Nothing else about the verb moves with it.
 */
export async function setRuntimeRoles(
  slaveId: string,
  roles: readonly string[],
  actor: string,
  origin: 'human' | 'system' = 'human',
): Promise<Result<void, ControlRefusal>> {
  const normalised = normaliseRoles(roles)
  if (!normalised.ok) return normalised

  // One locked transaction for the read and the write, as `setProfile`'s slave branch above: the
  // event needs the workspace the read found, the `FOR UPDATE` inside `lockSlave` keeps a row
  // deleted mid-verb a `slave_not_found` rather than an uncaught `P2025` (final review), and the
  // refusal is returned (not thrown) because it is reached before anything has been written.
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, slaveId)
    if (slave === null) return null
    await tx.slave.update({ where: { id: slaveId }, data: { runtimeRoles: normalised.value } })
    return { workspaceId: slave.team.workspaceId }
  })
  if (outcome === null) return err({ kind: 'slave_not_found', slaveId })

  await appendEvent({
    type: 'slave.runtime_roles_changed',
    workspaceId: outcome.workspaceId,
    slaveId,
    actor: origin,
    payload: { slaveId, roles: normalised.value, actor },
  })
  return ok(undefined)
}

/**
 * The LOCAL half of a specialist profile (M46 R2).
 *
 * **Why this writes three columns and not one.** `profileOverrides` is what the operator said;
 * `profile` is the Markdown a run is actually given, and it is DERIVED, so it is re-rendered here
 * or it is stale; and `profileSha256` is the import's own record of what it wrote, which this verb
 * re-stamps deliberately. That last write is the entire mechanism by which an override survives an
 * upstream update: `importCatalog` skips a row as `locally_edited` when the stored profile's hash
 * disagrees with `profileSha256`, so a structured customisation that did NOT re-stamp would look
 * exactly like a hand-written profile and would freeze the row forever. A RAW Markdown override
 * (`setProfile({ templateId })`, R5) still does not re-stamp -- and that is now the only thing
 * `locally_edited` means.
 *
 * Refused on a template with no `profileSpec`: there is nothing to be a partial OF, and rendering
 * an empty spec over a hand-written profile would delete somebody's words.
 *
 * No event, for the reason {@link setProfile}'s docblock already gives: `ExecutionEvent.workspaceId`
 * is NOT NULL and a template belongs to no project (M42 R5/E3).
 */
export async function setProfileOverrides(
  templateId: string,
  patch: unknown,
  actor: string,
): Promise<Result<{ readonly overridden: readonly ProfileOverridableField[] }, ControlRefusal>> {
  const parsed = profileOverridesSchema.safeParse(patch)
  if (!parsed.success) {
    return err({
      kind: 'invalid_profile_overrides',
      detail: parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`.trim()).join('; '),
    })
  }
  return writeOverrides(templateId, actor, (current) => ({ ...current, ...parsed.data }))
}

/** Takes one field back to what the catalog says (R2). The whole column is written as NULL once
 *  the last override goes, so "nothing is customised" is one value rather than two.
 *
 *  The field is checked against `PROFILE_OVERRIDABLE_FIELDS`, the thirteen -- not the fourteen of
 *  `PROFILE_SPEC_FIELDS`: `runtimeRole` cannot be SET (plan erratum E21, `profileOverridesSchema`
 *  refuses it), so accepting a request to clear it would answer `ok` for a thing that was never
 *  there. */
export async function clearProfileOverride(
  templateId: string,
  field: string,
  actor: string,
): Promise<Result<{ readonly overridden: readonly ProfileOverridableField[] }, ControlRefusal>> {
  if (!(PROFILE_OVERRIDABLE_FIELDS as readonly string[]).includes(field)) {
    return err({ kind: 'unknown_profile_field', field })
  }
  return writeOverrides(templateId, actor, (current) => {
    const next: Record<string, unknown> = { ...current }
    delete next[field]
    return next as ProfileOverrides
  })
}

/**
 * The one writer both verbs share: lock the row, read both halves, apply the change, re-render.
 *
 * `SELECT ... FOR UPDATE` through the raw query the catalog's own verbs use, because two operators
 * customising two different fields of the same template in the same second must not lose one of
 * the two patches -- read-modify-write on a JSON column has no other protection.
 *
 * Every refusal here is reached BEFORE anything is written, so each is returned rather than
 * thrown; a refusal after the `update` below would have to throw, or Prisma commits the write
 * (ADR 0003).
 */
async function writeOverrides(
  templateId: string,
  actor: string,
  change: (current: ProfileOverrides) => ProfileOverrides,
): Promise<Result<{ readonly overridden: readonly ProfileOverridableField[] }, ControlRefusal>> {
  // Named on the signature and unused on purpose: these two verbs write no event and record no
  // author, for `setProfile`'s reason above, and dropping the parameter would make the web and CLI
  // call sites the odd ones out among the profile verbs.
  void actor
  return prisma.$transaction(
    async (tx): Promise<Result<{ readonly overridden: readonly ProfileOverridableField[] }, ControlRefusal>> => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "SlaveTemplate" WHERE id = ${templateId} FOR UPDATE
      `
      if (locked[0] === undefined) return err({ kind: 'template_not_found', templateId })
      const row = await tx.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })

      const spec = profileSpecSchema.safeParse(row.profileSpec)
      if (!spec.success) return err({ kind: 'profile_not_structured', templateId })

      const stored = profileOverridesSchema.safeParse(row.profileOverrides ?? {})
      // A stored patch this repository can no longer parse is not a reason to refuse the operator's
      // NEW change: it is dropped, and the change is applied to an empty patch. Nothing is lost that
      // the effective profile still had -- an unparseable override was already being ignored by
      // every reader.
      const next = change(stored.success ? stored.data : {})
      const overridden = overriddenFields(next)
      const profile = renderProfileSpec(effectiveProfileSpec(spec.data, next))

      await tx.slaveTemplate.update({
        where: { id: templateId },
        data: {
          profileOverrides: overridden.length === 0 ? Prisma.DbNull : (next as unknown as Prisma.InputJsonValue),
          profile,
          profileSha256: goalSha256(profile),
        },
      })
      return ok({ overridden })
    },
  )
}
