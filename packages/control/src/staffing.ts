import { prisma } from '@slave-of-ai/db/client'
import {
  capabilityLabel,
  err,
  ok,
  type CapabilityRecord,
  type Result,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/**
 * A person saying who -- or what model -- should take one capability on one project (M53 R9).
 *
 * The shape `setSlavePermission` / `clearSlavePermission` already have (`./permission.js`): one verb
 * to decide, one to take the decision back, every question asked BEFORE any write, the refusal
 * RETURNED, and the event appended after the row with both sides of the change and the person who
 * made it. Neither verb opens a database transaction of its own, so the house rule about a refusal
 * after a write inside one -- which must THROW, because a returned refusal commits -- cannot be
 * broken here: there is nothing to roll back, and every refusal below sits above the write it
 * precedes.
 *
 * A preference is ADVISORY. `rankCandidates` reads it at step 3 of seven and it never excludes
 * anybody: a preference for a busy worker loses to availability, and a preference for a template
 * this installation no longer has is simply a preference nobody satisfies.
 */

/** The SHAPE of a model name (R9). Nothing in this tree had one: `setSlaveModel` and
 *  `createTemplate` only ask that the text is not blank, and `'not a model!'` would pass that -- a
 *  preference is stored and read back months later, so "it is not empty" is not enough of a check
 *  to put a person's decision behind. Deliberately permissive about the VOCABULARY (`opus`,
 *  `claude-sonnet-4-20250514`, `us.anthropic.claude-opus-4:1`, `gpt-4o` all pass) and strict about
 *  the FORM: one word, no whitespace and no punctuation a model id has never carried. This product
 *  does not own the list of model names and must not pretend to. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/

/**
 * The RULE above, in words, for the `invalid_model` sentence (fix round 1, Important 1).
 *
 * `invalid_model`'s default sentence is "a model must be a non-empty text", which was written for
 * `setSlaveModel`'s only check and is simply untrue of this caller: an operator who types `gpt 4o`
 * would be told a non-empty value is empty, and given no hint of the rule they actually broke. The
 * kind is still the right one -- a new kind costs three homes to say what this one says -- so it
 * takes `invalid_name`'s optional `detail` (M52's precedent, one line above it in the union) and
 * this is the detail.
 *
 * The RULE in plain words and never the pattern as prose: a regular expression in a sentence is a
 * thing an operator has to decode before they can fix their own typo.
 */
const MODEL_SHAPE_DETAIL =
  'a model must be one word: a letter or digit, then any of . _ - : @ / — and no spaces'

/** One staffing decision, as every surface reads it -- the LABEL and the template's NAME beside the
 *  two keys, because a decision row is read a year later (`docs/ia.md` rule 3) and neither a key nor
 *  an id is a word. `setBy` is a `User.id` and stays one (M52 erratum E18): resolving it to a
 *  username is each surface's own boundary, not this module's. */
export interface StaffingPreferenceView {
  readonly capability: string
  readonly capabilityLabel: string
  readonly templateId: string | null
  readonly templateName: string | null
  readonly model: string | null
  readonly setBy: string | null
  readonly setAt: Date
}

/** What a person is asking for. At least one half must be named -- both together is one decision
 *  ("Atlas, and on opus"), and neither is a preference for nothing. */
export interface StaffingPreferenceInput {
  readonly capability: string
  readonly templateId?: string | null
  readonly model?: string | null
}

/** The side of a `staffing.preference_changed` payload: the decision as it read, or `null` for "no
 *  decision" -- which is what the table expresses by having no row. */
interface StaffingSide {
  readonly templateId: string | null
  readonly templateName: string | null
  readonly model: string | null
}

/** The taxonomy, for the ONE label this module puts in front of a person. Read per call and not
 *  cached: a preference is set by a person clicking, never by a tick, and a stale label is a wrong
 *  word in a stored event. */
async function taxonomyOf(): Promise<readonly CapabilityRecord[]> {
  const rows = await prisma.capability.findMany({ orderBy: { key: 'asc' } })
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    domain: row.domain,
    role: row.role,
    synonyms: row.synonyms,
  }))
}

/** The names behind a set of template ids, in ONE query and never one per row. An id with no row is
 *  simply absent from the map: `templateId` is a plain column with no foreign key (the
 *  `CollaborationHint.capability` precedent), so a template a preference names may since have been
 *  deleted, and the decision outlives it. */
async function templateNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  const rows = await prisma.slaveTemplate.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })
  return new Map(rows.map((row) => [row.id, row.name]))
}

/**
 * Set -- or replace -- the decision for one capability on one project (R9).
 *
 * Every question is asked before any write, in the order a person would: is there a project, does
 * the request say anything at all, is the capability a real one, is the template real, is the model
 * shaped like a model. The last two are the EXISTING kinds (`template_not_found`, `invalid_model`):
 * a new kind costs three homes and says nothing the old one did not.
 *
 * Returns `ok` unchanged and writes NO EVENT when the decision already reads exactly this -- the
 * `setSlavePermission` `from === mode` precedent (plan decision D17), which is what keeps a UI that
 * re-submits on every render from filling the activity log with a change that changed nothing. The
 * row keeps its original `setBy`, for the same reason `grantedBy` does: it answers "who decided
 * this", not "who last looked at it".
 */
export async function setStaffingPreference(
  workspaceId: string,
  input: StaffingPreferenceInput,
  principal?: Principal,
): Promise<Result<StaffingPreferenceView, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const templateId = input.templateId ?? null
  const model = input.model ?? null
  if (templateId === null && model === null) {
    return err({ kind: 'invalid_staffing_preference', capability: input.capability })
  }

  const taxonomy = await taxonomyOf()
  if (!taxonomy.some((row) => row.key === input.capability)) {
    return err({ kind: 'capability_not_found', key: input.capability })
  }
  // The template is read HERE, before the write, and its name is carried into the event below --
  // one reading of one row, answering both "is this real" and "what is it called".
  const template =
    templateId === null
      ? null
      : await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { id: true, name: true } })
  if (templateId !== null && template === null) return err({ kind: 'template_not_found', templateId })
  if (model !== null && !MODEL_ID_PATTERN.test(model)) {
    return err({ kind: 'invalid_model', detail: MODEL_SHAPE_DETAIL })
  }

  // The read-before-write is the EVENT's, not a race guard -- `permission.ts`'s own note on why two
  // writers meeting here produce two honest events rather than a lock applies unchanged.
  const prior = await prisma.staffingPreference.findUnique({
    where: { workspaceId_capability: { workspaceId, capability: input.capability } },
  })
  const names = await templateNames([templateId, prior?.templateId ?? null].flatMap((id) => (id === null ? [] : [id])))
  const to: StaffingSide = { templateId, templateName: template?.name ?? null, model }
  const from: StaffingSide | null =
    prior === null
      ? null
      : {
          templateId: prior.templateId,
          templateName: prior.templateId === null ? null : names.get(prior.templateId) ?? null,
          model: prior.model,
        }

  if (prior !== null && from !== null && from.templateId === to.templateId && from.model === to.model) {
    return ok(viewOf(prior, to.templateName, taxonomy))
  }

  // `@@unique([workspaceId, capability])` makes this a replacement in place -- one decision per
  // capability per project, never a stack of them. `setAt` and `setBy` are written explicitly on the
  // update half: the column defaults to `now()` on INSERT only and there is no `@updatedAt`, so a
  // replacement that did not touch them would print the moment the FIRST decision was taken beside
  // the second one's author.
  const row = await prisma.staffingPreference.upsert({
    where: { workspaceId_capability: { workspaceId, capability: input.capability } },
    create: { workspaceId, capability: input.capability, templateId, model, setBy: principal?.userId ?? null },
    update: { templateId, model, setBy: principal?.userId ?? null, setAt: new Date() },
  })
  await appendPreferenceChanged(workspaceId, input.capability, taxonomy, from, to, principal)
  return ok(viewOf(row, to.templateName, taxonomy))
}

/**
 * Take the decision back (R9): the ROW is deleted, and the capability returns to "nobody asked".
 *
 * Deleting nothing is SUCCESS, not a refusal -- `clearSlavePermission`'s own rule: DELETE is
 * idempotent, and "there was nothing to take back" is the caller's desired end state. No row, no
 * change, no event. `deleteMany` rather than `delete`, so a concurrent clear of the same capability
 * does not throw on a row that is already in the state this caller wanted.
 */
export async function clearStaffingPreference(
  workspaceId: string,
  capability: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const prior = await prisma.staffingPreference.findUnique({
    where: { workspaceId_capability: { workspaceId, capability } },
  })
  if (prior === null) return ok(undefined)

  const names = await templateNames(prior.templateId === null ? [] : [prior.templateId])
  const from: StaffingSide = {
    templateId: prior.templateId,
    templateName: prior.templateId === null ? null : names.get(prior.templateId) ?? null,
    model: prior.model,
  }
  await prisma.staffingPreference.deleteMany({ where: { workspaceId, capability } })
  await appendPreferenceChanged(workspaceId, capability, await taxonomyOf(), from, null, principal)
  return ok(undefined)
}

/** Every decision a person has taken about this project, capability ascending. The template names
 *  are resolved in ONE `findMany` over the distinct ids -- never one query per row, which is the
 *  shape that turns a table of ten preferences into eleven round trips. */
export async function listStaffingPreferences(workspaceId: string): Promise<readonly StaffingPreferenceView[]> {
  const rows = await prisma.staffingPreference.findMany({ where: { workspaceId }, orderBy: { capability: 'asc' } })
  if (rows.length === 0) return []
  const names = await templateNames(rows.flatMap((row) => (row.templateId === null ? [] : [row.templateId])))
  const taxonomy = await taxonomyOf()
  return rows.map((row) =>
    viewOf(row, row.templateId === null ? null : names.get(row.templateId) ?? null, taxonomy),
  )
}

function viewOf(
  row: {
    readonly capability: string
    readonly templateId: string | null
    readonly model: string | null
    readonly setBy: string | null
    readonly setAt: Date
  },
  templateName: string | null,
  taxonomy: readonly CapabilityRecord[],
): StaffingPreferenceView {
  return {
    capability: row.capability,
    capabilityLabel: capabilityLabel(row.capability, taxonomy),
    templateId: row.templateId,
    templateName,
    model: row.model,
    setBy: row.setBy,
    setAt: row.setAt,
  }
}

/** The one `staffing.preference_changed` append, shared by the set and the clear so the triple a
 *  person reads is spelled once. AFTER the write and outside any transaction: the decision is the
 *  fact, and an append that threw inside one would roll back the very change it failed to record. */
async function appendPreferenceChanged(
  workspaceId: string,
  capability: string,
  taxonomy: readonly CapabilityRecord[],
  from: StaffingSide | null,
  to: StaffingSide | null,
  principal: Principal | undefined,
): Promise<void> {
  await appendEvent({
    type: 'staffing.preference_changed',
    workspaceId,
    actor: 'human',
    payload: {
      capability,
      // The LABEL beside the key, for `permission.changed`'s reason: a card must print a word
      // without a join, and a reader months later should not have to hold the taxonomy in their head.
      capabilityLabel: capabilityLabel(capability, taxonomy),
      from,
      to,
      by: principal?.userId ?? null,
    },
    userId: principal?.userId ?? null,
  })
}
