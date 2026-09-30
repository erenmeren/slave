import { SMOKE_SCRIPT_PATH, VERIFY_SCRIPT_PATH } from '../conduct/skeleton.js'
import { SUPERVISOR_PER_CALL_CAP_USD } from '../supervisor/constants.js'

/**
 * The life of one intake (M59 R1), as data.
 *
 * Declared HERE rather than in `packages/db/src/enums.ts` for `docs/ia.md` rule 3's reason: the
 * label table below is read by `apps/web`'s CLIENT bundle, which can import this package and
 * cannot import Prisma. `packages/db/test/integration/enum-parity.test.ts` pins the Postgres enum
 * to this list, the way it already pins `SITUATION_KINDS`.
 */
export const INTAKE_STATUSES = [
  'open',
  'awaiting_reply',
  'replying',
  'drafted',
  'creating',
  'created',
  'failed',
  'abandoned',
] as const

export type IntakeStatus = (typeof INTAKE_STATUSES)[number]

/**
 * What each status is CALLED (`docs/ia.md` rule 3). A total `Record`, so a ninth status fails the
 * BUILD here rather than turning up on a card as an identifier.
 *
 * Written from the PERSON's side of the conversation, not the machine's: `awaiting_reply` and
 * `replying` are both "thinking" to somebody watching a drawer, and the difference between them --
 * whether a daemon has picked the message up yet -- is a fact about this system that the raw
 * member still carries in `title`.
 */
export const INTAKE_STATUS_LABEL: Record<IntakeStatus, string> = {
  open: 'Your turn',
  awaiting_reply: 'Thinking',
  replying: 'Thinking',
  drafted: 'Ready to create',
  creating: 'Creating the project',
  created: 'Created',
  failed: 'Stopped part way',
  abandoned: 'Abandoned',
}

/** Who said one line (M59 R2). `fact` is this system reading the filesystem -- neither the person
 *  nor the model, and a surface that showed it as either would be lying about provenance. */
export const INTAKE_ROLES = ['human', 'assistant', 'fact'] as const

export type IntakeRole = (typeof INTAKE_ROLES)[number]

export const INTAKE_ROLE_LABEL: Record<IntakeRole, string> = {
  human: 'You',
  assistant: 'Assistant',
  fact: 'What we found',
}

/** The steps `acceptIntake` runs, in order (M59 R10). The array IS the order: `acceptIntake`
 *  iterates it, and a resume after a failure restarts at the first entry not `done`. */
export const INTAKE_STEPS = [
  'init_repository',
  'create_workspace',
  'staff',
  'set_goal',
  'mark_created',
] as const

export type IntakeStep = (typeof INTAKE_STEPS)[number]

export const INTAKE_STEP_LABEL: Record<IntakeStep, string> = {
  init_repository: 'Create the repository',
  create_workspace: 'Create the project',
  staff: 'Put a team on it',
  set_goal: 'Write the goal',
  mark_created: 'Finish',
}

export const INTAKE_STEP_STATUSES = ['done', 'failed', 'skipped'] as const

export type IntakeStepStatus = (typeof INTAKE_STEP_STATUSES)[number]

export const INTAKE_STEP_STATUS_LABEL: Record<IntakeStepStatus, string> = {
  done: 'Done',
  failed: 'Stopped',
  skipped: 'Skipped',
}

/**
 * The most model calls one conversation may ever make (M59 R12).
 *
 * Twelve, and the twelfth is the last: `sendIntakeMessage` refuses afterwards and the drawer
 * switches to the form pre-filled with whatever the conversation reached. A cap rather than a
 * budget because the failure it guards against is not expense, it is a loop -- a person and a
 * model talking past each other forever, at a dollar a turn.
 */
export const INTAKE_MAX_MODEL_CALLS = 12

/** The ceiling on ONE intake call, and what an unmeasured one is charged at when spend is summed.
 *  The SUPERVISOR's own number by assignment rather than by coincidence (R12): both are the
 *  daemon asking one question on the operator's behalf, and two numbers would drift. */
export const INTAKE_PER_CALL_CAP_USD = SUPERVISOR_PER_CALL_CAP_USD

/** How long a daemon's claim on an intake stands before another daemon may take it (M59 R11).
 *  Five minutes: a model call is capped well below that, so a `replying` row older than this is a
 *  process that died holding it. */
export const INTAKE_CLAIM_TTL_MS = 5 * 60_000

/**
 * The longest brief intake carries WHOLE: one message a person sends, the goal a draft proposes
 * (`intakeDraftSchema`), a person's line as the model reads it (`buildIntakePrompt`) and the
 * person's words `acceptIntake` records as the goal's `request`.
 *
 * ONE NUMBER FOR ALL FOUR, because they are one text at four stops. The brief a person pastes is
 * the goal the draft restates, the line the model drafts from and the request the Supervisor
 * conversation opens with; a smaller cap at any one stop silently cuts the brief there while the
 * others accept it whole. That is exactly what happened before: the message and the goal stopped at
 * 8000, the prompt cut the person's line at 4000 ({@link INTAKE_TEXT_MAX_CHARS}, the cap on what the
 * MODEL may say, applied to the person too) and the request at 4000 -- so a large project's brief
 * (19.5k characters, the benchmark's large case) could not enter intake at all, and one that had
 * would have been drafted from its first fifth.
 *
 * WHY 32 000. The size of a real specification with room over the largest one measured (19.5k): a
 * project that big is described in a document, and asking the person to cut their document to fit
 * a text box loses precisely the detail a large project needs. It stays a CAP rather than none
 * because every character is re-sent on each of up to {@link INTAKE_MAX_MODEL_CALLS} calls: the
 * worst case, a conversation of full-length messages, is a few hundred thousand characters per
 * call -- well inside a model's context and {@link INTAKE_PER_CALL_CAP_USD}, where an unbounded
 * message is neither.
 *
 * `set-goal` has no cap at all; this one is only intake's, and it is not the Supervisor chat's
 * (`CHAT_MESSAGE_MAX_CHARS`, which has its own budget and its own reason).
 */
export const INTAKE_BRIEF_MAX_CHARS = 32_000

/** The longest `text` a model may hand back in one answer -- `ANSWER_MAX_CHARS`' own number and
 *  its own reason (`../supervisor/constants.ts`): past it the model has stopped answering and
 *  started writing the project. */
export const INTAKE_TEXT_MAX_CHARS = 4_000


/**
 * The gate a project whose repository did not exist yet is created with (M60 §7b).
 *
 * SYSTEM-AUTHORED, and that is the point: a model asked to name a gate for code nobody has written
 * can only invent one, and an invented gate is what `npx html-validate index.html` was on a project
 * with no `index.html` -- the gate no task could pass, and the one two runs rewrote the control
 * database to escape. `intakeDraftSchema` therefore lets the model answer `[]` for a new
 * repository, and `acceptIntake` puts THIS in its place.
 *
 * It names the project's own script rather than a stack's test runner because the stack is not
 * known yet either. The script is PLANTED with the repository ({@link INTAKE_BOOTSTRAP_VERIFY_SCRIPT},
 * in the first commit, executable) rather than asked of the project: asked, the planner made the
 * whole board wait on it (observed 2026-09-20: a research task depending on a shell script) and a
 * stub cost an implementation run and a review. {@link INTAKE_BOOTSTRAP_GOAL_CLAUSE} then tells
 * the planner the gate exists and must be extended, so every task is proven by a gate the project
 * itself grows.
 *
 * Never empty, whatever the model said: zero commands is `verify_not_configured`, which blocks the
 * task and halts the whole project on its first piece of work (`apps/orchestrator/src/verify.ts`).
 */
export const INTAKE_BOOTSTRAP_VERIFY_COMMAND = 'bash scripts/verify.sh'

/** Where the planted gate lives, relative to the repository root -- the path
 *  {@link INTAKE_BOOTSTRAP_VERIFY_COMMAND} runs. */
export const INTAKE_BOOTSTRAP_VERIFY_SCRIPT_PATH = VERIFY_SCRIPT_PATH

/**
 * The planted gate's body (M60 §7b; skeleton spec S4, 2026-09-30). A RUNNER, not a list of checks:
 * it runs every `scripts/verify.d/*.sh` in name order and stops at the first that fails, so each
 * work package owns exactly one file of its own there and no two packages ever edit the same gate
 * (OBS-10, OBS-22). With no check yet it says so and passes: there is nothing to check.
 * `LC_ALL=C` makes "name order" byte order, whatever the host's locale.
 */
export const INTAKE_BOOTSTRAP_VERIFY_SCRIPT = [
  '#!/usr/bin/env bash',
  "# This project's verification gate. A task is accepted only when this script exits 0.",
  '# It runs every scripts/verify.d/*.sh in name order and stops at the first that fails.',
  '# Add your checks as your own file there: a work package adds only scripts/verify.d/<package-key>.sh;',
  '# a project delivered by one worker adds its checks to scripts/verify.d/. Checks are added, never',
  '# removed or weakened. Runs from the repository root.',
  'set -euo pipefail',
  'export LC_ALL=C',
  'cd "$(dirname "${BASH_SOURCE[0]}")/.."',
  'shopt -s nullglob',
  'checks=(scripts/verify.d/*.sh)',
  'if [ "${#checks[@]}" -eq 0 ]; then',
  '  echo "no checks yet"',
  '  exit 0',
  'fi',
  'for check in "${checks[@]}"; do',
  '  echo "== ${check}"',
  '  bash "${check}"',
  'done',
  '',
].join('\n')

/** Skeleton spec S4: what the smoke stub prints, and its exit code -- Plan B reads the pair as "not written yet". */
export const SMOKE_STUB_MESSAGE = 'smoke not written yet'
export const SMOKE_STUB_EXIT_CODE = 2

export const INTAKE_BOOTSTRAP_SMOKE_SCRIPT_PATH = SMOKE_SCRIPT_PATH

/** Skeleton spec S4/S5: the smoke stub a new repository starts with, carrying the contract it must grow into. */
export const INTAKE_BOOTSTRAP_SMOKE_SCRIPT = [
  '#!/usr/bin/env bash',
  '# The smoke check. `bash scripts/smoke.sh` from the repository root must start the product through',
  '# the path the README documents (Docker if the README says Docker), run one basic user flow end to',
  '# end against it (for example: sign in, add a record, see it in a list), stop everything it started,',
  '# and exit 0 only if the flow worked. $SLAVEOFAI_SMOKE_PROJECT is a unique name for any compose',
  '# project or container name prefix; never publish on a fixed host port without checking it is free.',
  '# Print what it does. Until the product can be started, this stub says so and exits 2.',
  `echo "${SMOKE_STUB_MESSAGE}"`,
  `exit ${String(SMOKE_STUB_EXIT_CODE)}`,
  '',
].join('\n')

/**
 * Appended to the goal of a project created with {@link INTAKE_BOOTSTRAP_VERIFY_COMMAND}, because
 * the goal is what the planner reads: a gate the planner does not know about is a gate no task
 * extends, and then the whole project is proven by a script that checks nothing.
 *
 * Spelled as a rule about EVERY task rather than as a task of its own. The earlier wording
 * ("Before anything else, create `scripts/verify.sh`") read as a first task, and the planner
 * obeyed it: every other task depended on the script, research and design waited on a shell
 * stub, and the stub cost an implementation run and a review. The script now exists before the
 * planner is asked anything, so the clause says so and forbids the task it used to create.
 * Skeleton spec S4 (2026-09-30): the runner replaced "extend this script", so the clause now says
 * each check is its own file in `scripts/verify.d/`.
 */
export const INTAKE_BOOTSTRAP_GOAL_CLAUSE = [
  '',
  '`scripts/verify.sh` is this project\'s verification gate: a task is accepted only when it exits 0. It',
  'already exists: it runs every `scripts/verify.d/*.sh` in name order and checks nothing until one is there.',
  'Every task that produces work which can honestly be checked adds that check as its own file in',
  '`scripts/verify.d/` (a work package adds only `scripts/verify.d/<package-key>.sh`), in the same task;',
  'checks are added, never removed. `scripts/smoke.sh` is a stub until the product can be started; it must',
  'end up starting the product the way the README documents and running one basic user flow.',
  'Do not create a task for either script by itself, and never make other work wait on them.',
].join('\n')

/** How many Agency persona catalogue entries the facts may carry (M59 R6). Three hundred names
 *  and divisions is a few kilobytes; three hundred PROFILE BODIES would be twelve megabytes, which
 *  is why the summary carries neither a profile nor a description. */
export const INTAKE_CATALOGUE_MAX = 300

/** The most runtime roles one proposed seat may carry. `MAX_RUNTIME_ROLES`
 *  (`packages/control/src/profile.ts:32`) is the verb's own cap and this package may not import
 *  that one; a case in `packages/control/test/integration/intake.test.ts` pins the two together,
 *  which is the only place both can be imported at once. */
export const INTAKE_MAX_RUNTIME_ROLES = 20

/**
 * How many seats one draft may propose from a SINGLE persona (final review, Important 8).
 *
 * Three because a persona HAS three people: the Catalog Person Pool keeps `poolSlot` 1, 2 and 3 for
 * every active template and no more (`packages/control/src/personPool.ts`). A fourth seat from one
 * persona is a seat naming somebody who does not exist, and it was not refused anywhere -- the
 * total team cap of twelve let a draft ask for twelve copies of one specialist. `staffIntakeTeam`
 * then ran out of managed candidates partway down the list and quietly gave the surplus seats an
 * unmanaged person or nothing at all, so the team an operator approved and the team they got were
 * different teams, and the difference was never reported to them.
 *
 * This package may not import `POOL_SLOTS` from `packages/control` (the dependency runs the other
 * way, `INTAKE_MAX_RUNTIME_ROLES`' own note above), so the two are pinned together by a case in
 * `packages/control/test/integration/intake-accept.test.ts`, which can import both at once.
 */
export const INTAKE_MAX_SEATS_PER_TEMPLATE = 3

/** How many transcript lines one prompt carries, newest last. Forty: a conversation this long has
 *  already hit `INTAKE_MAX_MODEL_CALLS`, so this is a bound on a pathological paste rather than on
 *  an ordinary intake -- `THREAD_MESSAGES_MAX`' own number and its own reason. */
export const INTAKE_PROMPT_MESSAGES_MAX = 40
