import { sanitisePersonText } from '../handoff/contract.js'
import type { RequirementItem } from './requirements.js'
import { HANDOFF_CHANGE_MAX_CHARS, HANDOFFS_PER_REPORT_MAX, NOTE_MAX_CHARS, NOTES_PER_REPORT_MAX, SKELETON_PACKAGE_KEY } from './constants.js'
import { globToRegExp } from './glob.js'
import {
  gateRunsVerifyScript,
  isLiteralPath,
  manifestFamily,
  registrationGlob,
  trimSlash,
  VERIFY_CHECKS_DIR,
  VERIFY_SCRIPT_PATH,
  verifyCheckPathFor,
  type PackageRegistration,
} from './skeleton.js'

/**
 * The tag a package worker's final report is wrapped in (Conductor Plan 2). The pair is also in
 * `../run-context/markers.ts`' `MARKERS`, so quoted text cannot forge or close a report.
 */
export const SLAVE_REPORT_TAG = 'slave-report'

/**
 * Skeleton spec S1: what the skeleton package is for, said in its own contract -- rendered from
 * what it actually owns and what the repository already holds (final review I3). A fallback
 * skeleton (plan A D3) owns only the paths nobody claimed, so it is never ordered to deliver an
 * entry point or a manifest it cannot touch; a skeleton on a base that already has a product (goal
 * v2, an existing repository) keeps that product runnable rather than building an empty one over
 * it. README.md is the integration package's (it is none of S1's files, and RUN -- "starts through
 * the path its README documents" -- is integration's, S6) unless the conductor gave it to the skeleton.
 */
export function renderSkeletonJobLines(ownedPaths: readonly string[], existingProduct: boolean | undefined): readonly string[] {
  const owns = (path: string): boolean => ownedPaths.some((glob) => globToRegExp(glob).test(path))
  const manifests = ownedPaths.filter((glob) => isLiteralPath(glob) && manifestFamily(glob).length > 0)
  const product =
    existingProduct === true
      ? 'This repository already has a product: make the existing product start and keep it runnable. Change only what starting it needs; do not rewrite a working entry point.'
      : existingProduct === false
        ? 'Deliver a runnable EMPTY product with the files you own: it starts and does nothing yet; the other packages add the features.'
        : 'If this repository already has a product, make the existing product start and keep it runnable (do not rewrite a working entry point); otherwise deliver a runnable EMPTY product with the files you own.'
  const dependencies =
    manifests.length > 0
      ? `Your dependency manifests and lockfiles: ${manifests.join(', ')}. Declare in them every dependency the goal will need now -- no other package may change a manifest or a lockfile.`
      : ownedPaths.some((glob) => !isLiteralPath(glob))
        ? 'Declare in any dependency manifest among your files every dependency the goal will need now -- no other package may change a manifest or a lockfile.'
        : 'You own no dependency manifest.'
  return [
    'Your package is the skeleton: it runs before every other package, and they all build on it.',
    product,
    dependencies,
    'If starting it needs a change in a file you do not own, list it in your report\'s "handOffs" with its path instead of making it.',
    'If you own the loader of a shared registration directory, make it load every file there: each package adds its own file; you own the loader, not the entries.',
    owns('README.md')
      ? 'Update README.md so it says how to start the product.'
      : 'README.md is not yours: the integration package, which runs last, documents how to start the product.',
  ]
}

/** Skeleton spec S5: the smoke contract, carried by the skeleton's contract (or the single package's). */
export const SMOKE_CONTRACT_LINES: readonly string[] = [
  'Write scripts/smoke.sh; the product is not accepted until it passes. The contract:',
  '- `bash scripts/smoke.sh` from the repository root starts the product through the path the README documents',
  '  (Docker if the README says Docker), runs one basic user flow end to end against it (for example: sign in as',
  '  the admin the README creates, add a record, see it in a list), stops everything it started, and exits 0 only',
  '  if the flow worked.',
  '- The flow changes something and reads the change back; a flow that only reads proves nothing. Where the product',
  '  stores data, it creates at least one record through the product\'s own interface (its API, UI or CLI) and reads',
  '  it back; where it stores nothing, it runs the product\'s main operation and checks the result.',
  '- It gets there with only the steps the README gives an operator (first admin, licence, settings); a step that',
  '  asks for input is answered with the values the README documents, through stdin, flags or the environment.',
  '  Never write to the database directly, and never switch off a licence, sign-in or permission check. Keep the',
  '  product\'s data in a temporary directory the smoke removes, not in the repository. If a README step cannot be',
  '  done with what ships in the repository (for example a licence that needs a vendor\'s private key), the smoke',
  '  fails and says which step.',
  '- Use $SLAVEOFAI_SMOKE_PROJECT as the compose project name and container name prefix, and never publish on',
  '  a fixed host port without first checking that it is free. Name any docker network or volume it creates',
  '  outside compose with that same prefix: after every run, containers, networks and volumes whose names',
  '  start with $SLAVEOFAI_SMOKE_PROJECT are removed, and anything named otherwise is left behind.',
  '- Print what it does, step by step. Only the stub exits 2 with "smoke not written yet".',
]

/**
 * Supervisor-as-conductor spec C1 (plan A D11): what a worker does with a change it may not make.
 * Replaces "ask the conductor (see the ask protocol)", which sent every hand-off to a person (OBS-3/4).
 */
export const HAND_OFF_RULE_LINES: readonly string[] = [
  'Do not create or change any other file: other workers own them. If your work needs a change in a file',
  'you do not own, or work another package must do, list it in your report\'s "handOffs" (with the path',
  'when there is one); it is delivered to the package that owns it. Never make the change yourself.',
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
    /** Human cards plan B D5: files a person gave to another package; absent reads as none. */
    readonly releasedPaths?: readonly string[]
  }
  readonly requirements: readonly RequirementItem[]
  readonly dependencies: readonly { readonly key: string; readonly interface: string }[]
  /** The workspace's verification gate (`Workspace.verifyCommands`), so the contract says where a
   *  check must go for that gate to run it (final review I1). */
  readonly verifyCommands: readonly string[]
  /** The skeleton only: whether its base already holds a product ({@link hasProductFiles});
   *  absent when that could not be read, and the job line then covers both. */
  readonly existingProduct?: boolean
  /** Plan A D9: blocks the caller rendered (shared decisions, what other packages asked of this one,
   *  what the packages before it reported), appended in order after a blank line; '' is skipped. */
  readonly notes?: readonly string[]
}

/**
 * Where this package's checks go, true for the project's real gate (final review I1):
 * - the gate runs scripts/verify.sh (a new repository whose draft named no gate, or a project whose
 *   gate is its own verify.sh): checks go in scripts/verify.d/, and the package that owns
 *   scripts/verify.sh -- the skeleton, or the single package -- makes it the runner if it is still
 *   a check list, keeping those checks;
 * - it does not (a draft that named `npm test`): a verify.d check is reached only if the gate
 *   happens to run it, so checks go where the gate runs them;
 * - no gate at all: said, with verify.d as the place a later gate can reach.
 */
function checkLines(key: string, single: boolean, verifyCommands: readonly string[]): readonly string[] {
  const own = single ? 'scripts/verify.d/' : verifyCheckPathFor(key)
  if (verifyCommands.length === 0) {
    return [`No verification gate is configured for this project yet. Add your checks to ${own} all the same.`]
  }
  const gate = `The verification gate (a task is accepted only when it passes): ${verifyCommands.map((c) => `\`${sanitisePersonText(c)}\``).join(', then ')}.`
  if (!gateRunsVerifyScript(verifyCommands)) {
    return [
      gate,
      `That gate does not run ${VERIFY_SCRIPT_PATH}, so a check in ${VERIFY_CHECKS_DIR}/ counts only if the gate itself reaches it: put your checks where it runs them, in files you own`,
      `(for example, tests its test runner discovers).${single ? '' : ` ${verifyCheckPathFor(key)} is yours too; never edit another package's check.`}`,
    ]
  }
  const runner = `${VERIFY_SCRIPT_PATH} runs every ${VERIFY_CHECKS_DIR}/*.sh in name order`
  const convert = `If ${VERIFY_SCRIPT_PATH} does not run every ${VERIFY_CHECKS_DIR}/*.sh in name order, make it do so, keeping its existing checks.`
  if (single) return [gate, `Add your checks to ${VERIFY_CHECKS_DIR}/. ${convert}`]
  if (key === SKELETON_PACKAGE_KEY) {
    return [gate, `Your checks go in ${own}. ${convert} Every other package's checks reach the gate only through it.`]
  }
  return [
    gate,
    `Your checks go in ${own} -- ${runner} (if it does not yet, the skeleton package, which runs before yours, makes it do so).`,
    "Add checks for what you built; never edit another package's check.",
  ]
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
    ...((input.pkg.releasedPaths ?? []).length === 0 ? [] : ['Given by a person to another package (no longer yours):', ...(input.pkg.releasedPaths ?? []).map((path) => `- ${path}`)]),
    ...(input.pkg.isIntegration ? ['- every file no other package owns'] : []),
    ...HAND_OFF_RULE_LINES,
  ]
  const single = input.pkg.ownedPaths.includes('**')
  if (input.pkg.key === SKELETON_PACKAGE_KEY) lines.push('', ...renderSkeletonJobLines(input.pkg.ownedPaths, input.existingProduct))
  if (input.pkg.key === SKELETON_PACKAGE_KEY || single) lines.push('', ...SMOKE_CONTRACT_LINES)
  lines.push('', ...checkLines(input.pkg.key, single, input.verifyCommands))
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
  for (const note of input.notes ?? []) if (note !== '') lines.push('', note)
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
    handOffs: [],
    notes: [],
  }
  return [
    'When you finish, end your final message with this report, exactly once:',
    `<${SLAVE_REPORT_TAG}>${JSON.stringify(example)}</${SLAVE_REPORT_TAG}>`,
    '- "requirements": one entry per requirement key above, each exactly once, status done|partial|not_done.',
    workflowSteps > 0
      ? `- "workflow": one entry per workflow step (${workflowSteps}), by its number.`
      : '- "workflow": [] (you were given no workflow).',
    '- "handOffs": a change in a file you do not own ({"path": "...", "change": "..."}) or work another package must do',
    '  ({"package": "<key>", "change": "..."}); each is delivered to the package that owns it.',
    `  At most ${String(HANDOFFS_PER_REPORT_MAX)}; each "change" at most ${String(HANDOFF_CHANGE_MAX_CHARS)} characters, with exactly one of "path" or "package".`,
    '  An item that breaks these is not delivered: it goes to the conductor as a question.',
    '- "questions": a choice nobody has made (a design decision, an ambiguous requirement) for the conductor to decide; never a hand-off.',
    `- "notes": what a person should know that needs no decision (a placeholder key, a limit you accepted, a manual step for release); at most ${String(NOTES_PER_REPORT_MAX)}, each at most ${String(NOTE_MAX_CHARS)} characters. A note goes to the activity feed and the goal report: never put one in "questions" or "handOffs".`,
    'A missing or malformed report sends this task back to you.',
  ].join('\n')
}
