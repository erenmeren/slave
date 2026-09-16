import { z } from 'zod'
import { INTAKE_CATALOGUE_MAX } from './constants.js'

/** One verify command detection found, and WHERE it found it (M59 R6). The source is shown on the
 *  chip's `title` and is what makes a suggestion checkable: "npm test" is a claim, "package.json
 *  scripts.test" is the evidence for it. */
export const verifyFindingSchema = z.object({
  command: z.string().min(1).max(500),
  source: z.string().min(1).max(200),
})

export type VerifyFinding = z.infer<typeof verifyFindingSchema>

/** What one path turned out to be. Every field is a MEASUREMENT -- nothing here is a preference,
 *  a default or a guess, which is what lets the prompt say "these are facts". */
export const pathFactSchema = z.object({
  path: z.string().min(1).max(4096),
  exists: z.boolean(),
  isRepository: z.boolean(),
  isEmptyDir: z.boolean(),
  branches: z.array(z.string().min(1).max(200)).max(200),
  defaultBranch: z.string().min(1).max(200).nullable(),
  verify: z.array(verifyFindingSchema).max(20),
})

export type PathFact = z.infer<typeof pathFactSchema>

/**
 * One row of the Agency persona catalogue, as the model sees it (M59 R6, plan erratum E8).
 *
 * `role` and not `runtimeRoles`: a template carries a `role`, which since M37 is the persona's
 * TITLE, and `runtimeRoles` is a column on `Slave` -- a per-SEAT fact. What a seat may be
 * dispatched as is what the model proposes in the draft and what `ensureStaffRoles` completes.
 *
 * No profile and no description: 279 profiles at 48k characters each is not a prompt.
 */
export const intakeCatalogueEntrySchema = z.object({
  templateId: z.string().min(1),
  name: z.string().min(1).max(200),
  division: z.string().max(200).nullable(),
  role: z.string().min(1).max(200),
})

export type IntakeCatalogueEntry = z.infer<typeof intakeCatalogueEntrySchema>

/** Everything the model is told, and nothing it is told to believe (M59 R6). Stored on the `fact`
 *  row's `facts` column and fenced into the prompt as data. */
export const intakeFactsSchema = z.object({
  paths: z.array(pathFactSchema).max(8),
  reposRoot: z.string().min(1).max(4096),
  existingCompanies: z.array(z.object({ id: z.string().min(1), name: z.string().min(1).max(200) })).max(100),
  catalogue: z.array(intakeCatalogueEntrySchema).max(INTAKE_CATALOGUE_MAX),
})

export type IntakeFacts = z.infer<typeof intakeFactsSchema>

/** How many other branches one summary line names before it stops. Four is enough to say "this
 *  repository has several"; a repository with two hundred would otherwise put all of them in a
 *  chat bubble. */
const OTHER_BRANCHES_SHOWN = 4

/**
 * The sentence the conversation SHOWS for a set of facts (M59 R6) -- one line per path, in the
 * order they were detected.
 *
 * Pure, and in the domain rather than beside the detector, because two surfaces render it: the
 * `fact` row's own `text` column (written once, by `sendIntakeMessage`) and any later reader of
 * that row. An empty string means "nothing was found", and the caller writes no `fact` row at all
 * rather than a row that says nothing.
 */
export function factsSummary(facts: IntakeFacts): string {
  const lines: string[] = []
  for (const path of facts.paths) {
    if (!path.exists) {
      lines.push(`${path.path} does not exist yet`)
      continue
    }
    if (!path.isRepository) {
      lines.push(`${path.path} is ${path.isEmptyDir ? 'an empty folder' : 'a folder'}, not a git repository yet`)
      continue
    }
    const others = path.branches.filter((branch) => branch !== path.defaultBranch)
    const branch =
      path.defaultBranch === null
        ? 'no branch yet'
        : `${path.defaultBranch}${others.length === 0 ? '' : ` (also ${others.slice(0, OTHER_BRANCHES_SHOWN).join(', ')})`}`
    const verify =
      path.verify.length === 0
        ? 'found no verify command'
        : `found ${path.verify.map((finding) => finding.command).join(', ')}`
    lines.push(`${path.path} is a git repository on ${branch}; ${verify}`)
  }
  return lines.join('\n')
}
