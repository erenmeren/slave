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

/** The longest single message a person may send. Eight thousand characters is a long description
 *  of a project and a short document; past it the person is pasting a specification, and the goal
 *  field (also 8000) is where that belongs. */
export const INTAKE_MESSAGE_MAX_CHARS = 8_000

/** The longest `text` a model may hand back in one answer -- `ANSWER_MAX_CHARS`' own number and
 *  its own reason (`../supervisor/constants.ts`): past it the model has stopped answering and
 *  started writing the project. */
export const INTAKE_TEXT_MAX_CHARS = 4_000

/** How much of the human half of the transcript `acceptIntake` puts on the `workspace.goal_set`
 *  event as its `request` (M59 R10 step 4). The same cap for the same reason. */
export const INTAKE_TRANSCRIPT_MAX_CHARS = 4_000

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
 * known yet either. The script does not exist at creation: {@link INTAKE_BOOTSTRAP_GOAL_CLAUSE} is
 * what puts writing it in the goal, so the project's first task creates it and every task after
 * that is proven by a gate the project itself defined.
 *
 * Never empty, whatever the model said: zero commands is `verify_not_configured`, which blocks the
 * task and halts the whole project on its first piece of work (`apps/orchestrator/src/verify.ts`).
 */
export const INTAKE_BOOTSTRAP_VERIFY_COMMAND = 'bash scripts/verify.sh'

/**
 * Appended to the goal of a project created with {@link INTAKE_BOOTSTRAP_VERIFY_COMMAND}, because
 * the goal is what the planner reads: a gate that nothing in the project is asked to create is a
 * gate the first task fails three times over.
 *
 * Spelled as a requirement on the work rather than as a note about the system. The planner turns a
 * goal into tasks, so this has to read as something to DO.
 */
export const INTAKE_BOOTSTRAP_GOAL_CLAUSE = [
  '',
  'Before anything else, create `scripts/verify.sh`: an executable script that checks this',
  "project's work and exits non-zero when it is not right. Every task in this project is verified",
  'by running it, so it must exist and pass before any other work can be accepted. Start it with',
  'whatever can honestly be checked about the first deliverable and extend it as the project grows.',
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
