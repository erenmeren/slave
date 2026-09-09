import { createHash } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'
import { PROFILE_MAX_CHARS, err, ok, type Result } from '@slave-of-ai/domain'
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
 */
export async function setRuntimeRoles(
  slaveId: string,
  roles: readonly string[],
  actor: string,
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
    actor: 'human',
    payload: { slaveId, roles: normalised.value, actor },
  })
  return ok(undefined)
}
