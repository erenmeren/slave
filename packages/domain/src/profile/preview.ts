import { effectiveProfileSpec, profileOverridesSchema, profileSpecSchema, type ProfileSpec } from './spec.js'

/** What a card shows of a profile's `workflow` (workforce cards spec §2): the first steps and how
 *  many there are in all, so "+N steps" is a count and never a guess. */
export interface WorkflowPreview {
  readonly steps: readonly string[]
  readonly total: number
}

/** Three is the card's height budget for a workflow (workforce cards spec): enough to show a shape,
 *  never so many the card grows past its row. */
export const WORKFLOW_PREVIEW_STEPS = 3

/** The answer for a profile with no workflow at all -- one value, so a test can compare to it. */
export const NO_WORKFLOW_PREVIEW: WorkflowPreview = { steps: [], total: 0 }

/**
 * The first {@link WORKFLOW_PREVIEW_STEPS} steps of an EFFECTIVE spec (overrides already applied).
 *
 * Blank steps are dropped before counting: an imported profile whose Workflow heading had an empty
 * bullet is a profile with one step fewer, and "+1 steps" over nothing is a count that lies.
 */
export function workflowPreview(spec: ProfileSpec | null, limit: number = WORKFLOW_PREVIEW_STEPS): WorkflowPreview {
  const steps = (spec?.workflow ?? []).map((step) => step.trim()).filter((step) => step !== '')
  return { steps: steps.slice(0, limit), total: steps.length }
}

/**
 * The same preview straight off the two stored JSON columns (`SlaveTemplate.profileSpec` and
 * `profileOverrides`), for a read that holds rows rather than a parsed spec.
 *
 * Never throws: a column that does not parse is a persona with no structured profile, which has
 * no workflow to preview; an overrides column that does not parse is ignored, the same rule
 * `catalogRowOf` follows.
 */
export function storedWorkflowPreview(specJson: unknown, overridesJson: unknown): WorkflowPreview {
  const spec = profileSpecSchema.safeParse(specJson)
  if (!spec.success) return NO_WORKFLOW_PREVIEW
  const overrides = profileOverridesSchema.safeParse(overridesJson ?? {})
  return workflowPreview(effectiveProfileSpec(spec.data, overrides.success ? overrides.data : {}))
}
