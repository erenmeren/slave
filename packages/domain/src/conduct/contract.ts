import { sanitisePersonText } from '../handoff/contract.js'
import type { RequirementItem } from './requirements.js'
import { SKELETON_PACKAGE_KEY } from './constants.js'
import {
  registrationGlob,
  trimSlash,
  verifyCheckPathFor,
  type PackageRegistration,
} from './skeleton.js'

/**
 * The tag a package worker's final report is wrapped in (Conductor Plan 2). The pair is also in
 * `../run-context/markers.ts`' `MARKERS`, so quoted text cannot forge or close a report.
 */
export const SLAVE_REPORT_TAG = 'slave-report'

/** Skeleton spec S1: what the skeleton package is for, said in its own contract. */
export const SKELETON_JOB_LINES: readonly string[] = [
  'Your package is the skeleton: it runs before every other package, and they all build on it.',
  'Deliver a runnable EMPTY product: the application entry point and server bootstrap, every dependency',
  'manifest with its lockfile (declare every dependency the goal will need now -- other packages cannot',
  'change them), the build, start and deploy files the README documents, and the loaders that read the',
  'shared registration directories (each package adds its own file there; you own the loader, not the',
  'entries). Update the README so it says how to start the product.',
]

/** Skeleton spec S5: the smoke contract, carried by the skeleton's contract (or the single package's). */
export const SMOKE_CONTRACT_LINES: readonly string[] = [
  'Write scripts/smoke.sh; the product is not accepted until it passes. The contract:',
  '- `bash scripts/smoke.sh` from the repository root starts the product through the path the README documents',
  '  (Docker if the README says Docker), runs one basic user flow end to end against it (for example: sign in,',
  '  add a record, see it in a list), stops everything it started, and exits 0 only if the flow worked.',
  '- Use $SLAVEOFAI_SMOKE_PROJECT as the compose project name and container name prefix, and never publish on',
  '  a fixed host port without first checking that it is free.',
  '- Print what it does, step by step. Only the stub exits 2 with "smoke not written yet".',
]

/** What {@link renderPackageContract} reads off a `WorkPackage` row -- only the fields it shows. */
export interface PackageContractInput {
  readonly pkg: {
    readonly key: string
    readonly title: string
    readonly ownedPaths: readonly string[]
    readonly isIntegration: boolean
    readonly interface: string
    /** The shared-directory prefixes this package owns (skeleton spec S3); absent reads as none. */
    readonly registrations?: readonly PackageRegistration[]
  }
  readonly requirements: readonly RequirementItem[]
  readonly dependencies: readonly { readonly key: string; readonly interface: string }[]
}

/**
 * The `package` run-context section's text: which requirements this worker owns, which files it
 * may touch, and what its package and the ones finished before it provide.
 *
 * Requirement and interface text came from the conductor's own output (a model), so it goes
 * through {@link sanitisePersonText} -- another party's text is data (M37 §1). Owned paths are
 * globs the conductor's schema already validated, and are shown as they are.
 */
export function renderPackageContract(input: PackageContractInput): string {
  const lines = [
    `Your work package: "${input.pkg.key}" -- ${input.pkg.title}`,
    '',
    input.requirements.length === 0
      ? 'This package has no requirements of its own.'
      : 'Requirements you own (each is checked, and you report on each):',
    ...input.requirements.map((r) => `${r.key}: ${sanitisePersonText(r.text)}`),
    '',
    'Files you own:',
    ...input.pkg.ownedPaths.map((g) => `- ${g}`),
    ...(input.pkg.isIntegration ? ['- every file no other package owns'] : []),
    'Do not create or change any other file: other workers own them. If your work needs a change',
    'outside your files, ask the conductor (see the ask protocol) instead of making it.',
  ]
  const single = input.pkg.ownedPaths.includes('**')
  if (input.pkg.key === SKELETON_PACKAGE_KEY) lines.push('', ...SKELETON_JOB_LINES)
  if (input.pkg.key === SKELETON_PACKAGE_KEY || single) lines.push('', ...SMOKE_CONTRACT_LINES)
  lines.push(
    '',
    single
      ? "Add your checks to scripts/verify.d/ (scripts/verify.sh runs every file there in name order), or to scripts/verify.sh if this project's script is not that runner."
      : `Your checks go in ${verifyCheckPathFor(input.pkg.key)} -- scripts/verify.sh runs every file in scripts/verify.d/ in name order. Add checks for what you built; never edit another package's check.`,
  )
  const registrations = input.pkg.registrations ?? []
  if (registrations.length > 0) {
    lines.push(
      '',
      'You add files to shared directories only through your own prefix (the skeleton owns the loader, not the entries):',
      ...registrations.map((r) => `- ${registrationGlob(r)} (in ${trimSlash(r.directory)}, which the skeleton loads)`),
      'Name every such file with that prefix, and never put such a file anywhere else.',
    )
  }
  if (input.pkg.interface.trim() !== '') {
    lines.push('', 'What your package provides and uses:', sanitisePersonText(input.pkg.interface))
  }
  if (input.dependencies.length > 0) {
    lines.push(
      '',
      'Packages finished before yours, and what they provide:',
      ...input.dependencies.map((d) => `- ${d.key}: ${sanitisePersonText(d.interface)}`),
    )
  }
  return lines.join('\n')
}

/**
 * The `report_protocol` run-context section's text: the exact `<slave-report>` shape the worker
 * ends with, with every requirement key it owns already filled in so a key cannot be forgotten.
 * `workflowSteps` is the count the run's `workflow` section rendered (0 when it has none).
 */
export function renderReportProtocol(requirementKeys: readonly string[], workflowSteps: number): string {
  const example = {
    requirements: requirementKeys.map((key) => ({
      key,
      status: 'done|partial|not_done',
      evidence: 'what shows it: a test, a command and its output, a file:line',
    })),
    filesTouched: ['path/you/changed'],
    workflow: workflowSteps > 0 ? [{ step: 1, done: true, note: '' }] : [],
    questions: [],
  }
  return [
    'When you finish, end your final message with this report, exactly once:',
    `<${SLAVE_REPORT_TAG}>${JSON.stringify(example)}</${SLAVE_REPORT_TAG}>`,
    '- "requirements": one entry per requirement key above, each exactly once, status done|partial|not_done.',
    workflowSteps > 0
      ? `- "workflow": one entry per workflow step (${workflowSteps}), by its number.`
      : '- "workflow": [] (you were given no workflow).',
    '- "questions": anything you need the conductor to decide; each is sent to it when you finish.',
    'A missing or malformed report sends this task back to you.',
  ].join('\n')
}
