import { sanitisePersonText } from '../handoff/contract.js'
import { CONDUCT_MAX_PACKAGES } from './constants.js'
import { CONDUCT_ANSWER_KEY } from './packages.js'
import type { RequirementItem } from './requirements.js'

export interface ConductPromptInput {
  readonly goal: string
  readonly requirements: readonly RequirementItem[]
  readonly repositoryMap: string
  readonly catalogue: string
  readonly previousError: string | null
}

/**
 * The conductor's size decision (spec R2). The prompt ARGUES for `single` -- the benchmark's
 * finding is that work fitting one session is done better by one session -- and allows
 * `partitioned` only for parts that own different files AND would not fit one session.
 *
 * The goal, the requirement texts and the repository map are person-authored or derived from
 * person-authored text, so each goes through {@link sanitisePersonText} (controller ruling 4):
 * neither a quoted worker-protocol marker nor a quoted routing literal inside them can steer this
 * or a later call. The catalogue is this system's own generated summary, not person-authored, so
 * it is left as-is.
 */
export function buildConductPrompt(input: ConductPromptInput): string {
  return [
    'You are the conductor of a software team. Decide how this goal is delivered.',
    '',
    'The default is "single": one worker does the whole goal. Choose "partitioned" only when BOTH hold:',
    '- the goal splits into parts that change different files, and',
    '- the whole would not fit one focused working session (roughly: more than ~2,000 changed lines or',
    '  many independent subsystems).',
    `A partitioned goal has 2 to ${CONDUCT_MAX_PACKAGES} packages. Each package owns files (repository-relative globs:`,
    '"**" any depth, "*" within one folder); no file may be owned by two packages, counting the files that',
    'exist and the new files each package lists in "newPaths". Every requirement belongs to exactly one package.',
    'A file no package owns belongs to the "integration" package, which runs last and wires the others',
    'together; name it yourself (key "integration") if it has requirements of its own.',
    '"interface" says what the package provides to others and uses from them (functions, types, CLI surface),',
    'so each worker can code against the others without touching their files.',
    'Pick each package\'s worker by "templateId" from the catalogue.',
    '',
    ...(input.previousError === null ? [] : [`Your previous answer was refused: ${input.previousError}`, '']),
    'The goal:',
    '<<<GOAL',
    sanitisePersonText(input.goal),
    'GOAL>>>',
    '',
    'Requirements:',
    ...input.requirements.map((r) => `${r.key}: ${sanitisePersonText(r.text)}`),
    '',
    'Repository (path (size): top-level symbols):',
    sanitisePersonText(input.repositoryMap),
    '',
    'Catalogue (templateId | name | division | capabilities):',
    input.catalogue,
    '',
    'Answer with one JSON object and nothing after it, either',
    `{"${CONDUCT_ANSWER_KEY}": {"mode": "single", "reason": "...", "templateId": "..."}}`,
    'or',
    `{"${CONDUCT_ANSWER_KEY}": {"mode": "partitioned", "reason": "why it does not fit one session", "packages": [`,
    '  {"key": "kebab-case", "title": "...", "requirementKeys": ["R1"], "ownedPaths": ["src/x/**"], "newPaths": [],',
    '   "interface": "...", "dependsOn": [], "templateId": "..."}], "integrationTemplateId": "..."}}',
  ].join('\n')
}
