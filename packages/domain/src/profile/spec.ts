import { z } from 'zod'
import { importedProfilePrefix } from '../catalog/persona.js'
import { PROFILE_MAX_CHARS } from '../run-context/profile.js'

/**
 * The SPECIALIST PROFILE (M46 R1): what a template says about the worker it makes, in fields
 * instead of one wall of Markdown.
 *
 * Two columns hold it and this file is the only thing that knows how they combine.
 * `SlaveTemplate.profileSpec` is UPSTREAM -- the importer writes it and re-writes it, and an
 * operator never edits it. `SlaveTemplate.profileOverrides` is LOCAL -- a PARTIAL object holding
 * only the fields an operator changed, which is what makes an override survive the next import:
 * the two live apart, so a new upstream spec cannot overwrite a field nobody upstream wrote.
 *
 * `SlaveTemplate.profile` -- the Markdown that actually reaches a prompt -- is DERIVED from the
 * two by {@link renderProfileSpec}, and is rewritten whenever either changes. Nothing downstream
 * of that column moved: `effectiveProfile`'s slave -> company -> template chain, the run
 * context's `WHO YOU ARE` block and its `{ kind: 'profile', origin, sha256 }` manifest entry are
 * exactly what M37 built.
 *
 * PURE, and it must stay that way: `packages/domain` is imported by `apps/web`'s CLIENT bundle,
 * so there is no `node:crypto`, no `node:fs` and no Prisma anywhere in this graph.
 */

/** A list item is a SHORT line, not a paragraph: 240 characters is a sentence and a half. */
export const PROFILE_SPEC_MAX_ITEM_CHARS = 240
/** Forty items is far past any persona in the reference corpus; it is a paste limit, not a design
 *  limit -- the same judgement `MAX_RUNTIME_ROLES` records. */
export const PROFILE_SPEC_MAX_ITEMS = 40

/** How much of a persona's structure the mapper actually recognised (R3). Never a score: three
 *  honest states, and `none` is a real answer that the catalog shows rather than hides. */
export type MappingQuality = 'full' | 'partial' | 'none'

/** docs/ia.md rule 3: no surface prints a bare enum member as its visible text. */
export const MAPPING_QUALITY_LABEL: Record<MappingQuality, string> = {
  full: 'mapped in full',
  partial: 'partly mapped',
  none: 'not mapped',
}

/** Where this profile came from (R4). Synthesised entirely by the importer -- no persona file in
 *  the reference corpus carries any of it. `importedAt` is an ISO string, not a `Date`: this
 *  object is stored as JSON and handed to a `'use client'` component. */
export interface ProfileSource {
  readonly repository: string
  readonly path: string
  readonly revision: string | null
  readonly license: string | null
  readonly importedAt: string
  readonly mappingQuality: MappingQuality
}

export interface ProfileSpec {
  readonly identity: string
  readonly summary: string
  readonly mission: string
  /** The role this template SUGGESTS, which is `SlaveTemplate.role`. Catalog metadata: the
   *  scheduler matches `Slave.runtimeRoles` and nothing else, so this is never rendered into a
   *  prompt (plan erratum E3). */
  readonly runtimeRole: string
  readonly capabilities: readonly string[]
  readonly expertise: readonly string[]
  readonly operatingPrinciples: readonly string[]
  readonly constraints: readonly string[]
  readonly workflow: readonly string[]
  readonly deliverables: readonly string[]
  readonly successCriteria: readonly string[]
  readonly collaborationHints: readonly string[]
  readonly recommendedSkills: readonly string[]
  /**
   * The persona's own remaining prose, verbatim (plan erratum E1).
   *
   * The mapper lifts a REPRESENTATIVE SUBSET of a persona's headings into the fields above; the
   * sections it does not know -- Communication Style, Learning & Memory, a decision framework, a
   * worked example -- are still the persona, and before this milestone they were the whole of
   * what reached the prompt. Dropping them would have made a `none`-quality persona a two-line
   * worker. It renders LAST and truncates FIRST.
   */
  readonly body: string
  readonly source: ProfileSource | null
}

export type ProfileSpecField = Exclude<keyof ProfileSpec, 'source'>

/** Every overridable field, in the order a drawer shows them. `source` is not here: provenance is
 *  a fact about where the text came from, and an operator who could edit it could make the
 *  catalog lie about its own history. */
export const PROFILE_SPEC_FIELDS: readonly ProfileSpecField[] = [
  'identity',
  'summary',
  'mission',
  'runtimeRole',
  'capabilities',
  'expertise',
  'operatingPrinciples',
  'constraints',
  'workflow',
  'deliverables',
  'successCriteria',
  'collaborationHints',
  'recommendedSkills',
  'body',
]

/** An exhaustive `Record`, so a fifteenth field cannot ship without someone deciding its copy
 *  (the `PROFILE_ORIGIN_TEXT` idiom, M44). */
export const PROFILE_FIELD_LABEL: Record<ProfileSpecField, string> = {
  identity: 'Who you are',
  summary: 'In one line',
  mission: 'Mission',
  runtimeRole: 'Suggested role',
  capabilities: 'Capabilities',
  expertise: 'Expertise',
  operatingPrinciples: 'Operating principles',
  constraints: 'Constraints',
  workflow: 'Workflow',
  deliverables: 'Deliverables',
  successCriteria: 'Success criteria',
  collaborationHints: 'Working with others',
  recommendedSkills: 'Recommended skills',
  body: 'In their own words',
}

/** Which editor a field gets, and which shape the schema enforces. */
export const PROFILE_FIELD_KIND: Record<ProfileSpecField, 'text' | 'list'> = {
  identity: 'text',
  summary: 'text',
  mission: 'text',
  runtimeRole: 'text',
  capabilities: 'list',
  expertise: 'list',
  operatingPrinciples: 'list',
  constraints: 'list',
  workflow: 'list',
  deliverables: 'list',
  successCriteria: 'list',
  collaborationHints: 'list',
  recommendedSkills: 'list',
  body: 'text',
}

/**
 * Render order AND keep-priority (R1, plan erratum E2): the renderer emits these in this order,
 * and when the result is over the cap it drops them from the END until it fits.
 *
 * The order is an argument about what a worker cannot do its job without. Who it is, in one line,
 * what it is for and what it must never do come first; the persona's own prose comes last because
 * it is the only section whose content is also, partly, in the sections above it. `runtimeRole`
 * is absent on purpose (E3).
 */
export const PROFILE_SECTION_PRIORITY: readonly ProfileSpecField[] = [
  'identity',
  'summary',
  'mission',
  'constraints',
  'operatingPrinciples',
  'capabilities',
  'expertise',
  'workflow',
  'deliverables',
  'successCriteria',
  'collaborationHints',
  'recommendedSkills',
  'body',
]

const shortText = z.string().max(PROFILE_SPEC_MAX_ITEM_CHARS)
const list = z.array(z.string().min(1).max(PROFILE_SPEC_MAX_ITEM_CHARS)).max(PROFILE_SPEC_MAX_ITEMS)

const profileSourceSchema: z.ZodType<ProfileSource> = z.object({
  repository: z.string().min(1),
  path: z.string().min(1),
  revision: z.string().nullable(),
  license: z.string().nullable(),
  importedAt: z.string().min(1),
  mappingQuality: z.enum(['full', 'partial', 'none']),
})

/**
 * Validates a stored `profileSpec` at READ, the `runContextManifestSchema` idiom -- a column that
 * is only ever written by this repository is still a column a person can edit with `psql`, and a
 * reader that trusted it would crash the catalog page instead of showing one unstructured row.
 * Strict on write, and `.strict()` on the object so a key nobody declared is a refusal rather than
 * silent data the next reader loses.
 */
export const profileSpecSchema: z.ZodType<ProfileSpec> = z
  .object({
    identity: shortText,
    summary: shortText,
    mission: shortText,
    runtimeRole: shortText,
    capabilities: list,
    expertise: list,
    operatingPrinciples: list,
    constraints: list,
    workflow: list,
    deliverables: list,
    successCriteria: list,
    collaborationHints: list,
    recommendedSkills: list,
    body: z.string().max(PROFILE_MAX_CHARS),
    source: profileSourceSchema.nullable(),
  })
  .strict()

/** The `| undefined` is `exactOptionalPropertyTypes`, not a second state: under that flag an
 *  optional key and a key explicitly set to `undefined` are different types, and zod's inferred
 *  output is the second -- the `RunContextManifestEntry` idiom (`run-context/sections.ts`). Both
 *  mean the same thing here, and {@link overriddenFields} reads them the same way. */
export type ProfileOverrides = { readonly [K in ProfileSpecField]?: ProfileSpec[K] | undefined }

/** The operator's half: the SAME shape, every key optional, and `source` refused outright. */
export const profileOverridesSchema: z.ZodType<ProfileOverrides> = z
  .object({
    identity: shortText.optional(),
    summary: shortText.optional(),
    mission: shortText.optional(),
    runtimeRole: shortText.optional(),
    capabilities: list.optional(),
    expertise: list.optional(),
    operatingPrinciples: list.optional(),
    constraints: list.optional(),
    workflow: list.optional(),
    deliverables: list.optional(),
    successCriteria: list.optional(),
    collaborationHints: list.optional(),
    recommendedSkills: list.optional(),
    body: z.string().max(PROFILE_MAX_CHARS).optional(),
  })
  .strict()

export function emptyProfileSpec(): ProfileSpec {
  return {
    identity: '',
    summary: '',
    mission: '',
    runtimeRole: '',
    capabilities: [],
    expertise: [],
    operatingPrinciples: [],
    constraints: [],
    workflow: [],
    deliverables: [],
    successCriteria: [],
    collaborationHints: [],
    recommendedSkills: [],
    body: '',
    source: null,
  }
}

/** The `<catalog>/<division>/<slug>` M42 already writes to `SlaveTemplate.sourceId`, rebuilt from
 *  the two halves the source record keeps -- so the prefix line the renderer emits is the same
 *  sentence `personaToTemplate` wrote before this milestone. */
export function profileSourceId(source: ProfileSource): string {
  return `${source.repository}/${source.path.replace(/\.md$/i, '')}`
}

/** Which fields an operator has taken over, in `PROFILE_SPEC_FIELDS` order (never `Object.keys`
 *  order, which is insertion order and would make two equal states print differently). */
export function overriddenFields(overrides: ProfileOverrides | null): readonly ProfileSpecField[] {
  if (overrides === null) return []
  return PROFILE_SPEC_FIELDS.filter((field) => overrides[field] !== undefined)
}

/**
 * UPSTREAM + LOCAL = EFFECTIVE (R1).
 *
 * Field by field, and an overridden LIST REPLACES the upstream list rather than merging into it.
 * A merge would make "take that constraint away" impossible to express, which is the same reason
 * `setRuntimeRoles` replaces a role set instead of adding to it.
 */
export function effectiveProfileSpec(spec: ProfileSpec | null, overrides: ProfileOverrides | null): ProfileSpec {
  const base = spec ?? emptyProfileSpec()
  if (overrides === null) return base
  const merged: Record<string, unknown> = { ...base }
  for (const field of PROFILE_SPEC_FIELDS) {
    const value = overrides[field]
    if (value !== undefined) merged[field] = value
  }
  return merged as unknown as ProfileSpec
}

const SECTION_HEADING: Record<ProfileSpecField, string> = PROFILE_FIELD_LABEL

function sectionText(spec: ProfileSpec, field: ProfileSpecField): string | null {
  const value = spec[field]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : `## ${SECTION_HEADING[field]}\n${trimmed}`
  }
  const items = value.map((item) => item.trim()).filter((item) => item !== '')
  if (items.length === 0) return null
  return `## ${SECTION_HEADING[field]}\n${items.map((item) => `- ${item}`).join('\n')}`
}

function compose(spec: ProfileSpec, keep: ReadonlySet<ProfileSpecField>): string {
  const blocks: string[] = []
  if (spec.source !== null) {
    blocks.push(importedProfilePrefix(profileSourceId(spec.source), new Date(spec.source.importedAt)))
  }
  for (const field of PROFILE_SECTION_PRIORITY) {
    if (!keep.has(field)) continue
    const text = sectionText(spec, field)
    if (text !== null) blocks.push(text)
  }
  return blocks.join('\n\n')
}

/**
 * The Markdown a run is given, from the effective spec (R1).
 *
 * **Why it truncates by WHOLE SECTIONS and not by characters.** `PROFILE_MAX_CHARS` is enforced
 * twice -- `setProfile` refuses a longer write, and `buildRunContext` refuses to dispatch a run
 * whose stored profile exceeds it -- so a rendered profile over the cap is not a cosmetic problem,
 * it is a worker that cannot be dispatched. Slicing mid-sentence would put half a constraint in
 * front of a model, which is worse than not putting it there at all; dropping the lowest-priority
 * WHOLE section leaves every sentence that survives intact and true.
 *
 * The last resort is a hard slice, reached only when the single highest-priority section is
 * itself longer than the cap. It cannot happen for an imported persona (M42 refuses a file whose
 * composed profile is over the cap before the mapper ever runs, plan erratum E6); it can happen
 * for an operator who pastes 20 000 characters into one override, and the cap is not negotiable.
 */
export function renderProfileSpec(spec: ProfileSpec): string {
  for (let end = PROFILE_SECTION_PRIORITY.length; end > 0; end -= 1) {
    const text = compose(spec, new Set(PROFILE_SECTION_PRIORITY.slice(0, end)))
    if (text.length <= PROFILE_MAX_CHARS) return text
  }
  return compose(spec, new Set(PROFILE_SECTION_PRIORITY.slice(0, 1))).slice(0, PROFILE_MAX_CHARS)
}
