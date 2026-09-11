import { capabilityLabel, type CapabilityRecord } from '../capability/taxonomy.js'
import type { ProfileSpec } from '../profile/spec.js'
import { RUNBOOK_MAX_STAGES, type RunbookStage } from './spec.js'

/** A runbook the importer is about to write: everything but the id and the timestamps. */
export interface RunbookDraft {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly keywords: readonly string[]
  readonly requiredCapabilities: readonly string[]
  readonly optionalCapabilities: readonly string[]
  readonly stages: readonly RunbookStage[]
  readonly source: 'persona'
  readonly sourceTemplateId: string
}

/** How long a stage title may be before it is trimmed. `RunbookStage.title` is capped at 400 by
 *  the schema; a persona's own bullet is sometimes a paragraph, and a panel wants a line. */
const TITLE_MAX = 160

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const trim = (line: string): string => {
  const flat = line.replace(/\s+/g, ' ').trim()
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1)}…`
}

/**
 * A persona's own process, as a runbook (R3).
 *
 * `ProfileSpec.workflow` is already the right list: M46's mapper lifts lines beginning `Step` or
 * `Phase` out of the Workflow section and falls back to that section's sub-headings and bullets
 * (`../catalog/spec.ts:344-347`). Each line becomes one stage, LINEARLY -- a persona writes its
 * process in order, and inventing a dependency graph out of prose would be a claim the file does
 * not make.
 *
 * `null` below two lines, which is R3's rule and the honest one: one step is not a process, and a
 * one-stage runbook would make every plan "fully adherent" by construction.
 *
 * No gates, no retry, no escalation: those are a project's own decisions, and a persona file has
 * never been asked for them. `keywords` are the template's capability LABELS -- the words a goal is
 * actually written in, where the keys are not.
 */
export function runbookFromProfileSpec(
  spec: ProfileSpec,
  template: { readonly id: string; readonly name: string; readonly capabilityKeys: readonly string[] },
  taxonomy: readonly CapabilityRecord[],
): RunbookDraft | null {
  if (spec.workflow.length < 2) return null
  const lines = spec.workflow.slice(0, RUNBOOK_MAX_STAGES)

  const stages: RunbookStage[] = lines.map((line, index) => ({
    key: `step-${String(index + 1)}`,
    title: trim(line),
    objective: trim(line),
    capabilities: [...template.capabilityKeys],
    dependsOn: index === 0 ? [] : [`step-${String(index)}`],
    expectedOutputs: [],
    gates: [],
    retry: null,
    escalation: null,
  }))

  return {
    key: `persona-${slug(template.name)}`,
    name: `${template.name} workflow`,
    description: `The ${String(lines.length)}-step process this specialist's own profile describes.`,
    keywords: template.capabilityKeys.map((key) => capabilityLabel(key, taxonomy)),
    requiredCapabilities: [...template.capabilityKeys],
    optionalCapabilities: [],
    stages,
    source: 'persona',
    sourceTemplateId: template.id,
  }
}
