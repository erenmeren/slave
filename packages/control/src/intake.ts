import { execFile } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  INTAKE_CATALOGUE_MAX,
  INTAKE_CLAIM_TTL_MS,
  INTAKE_MAX_MODEL_CALLS,
  INTAKE_MESSAGE_MAX_CHARS,
  INTAKE_STEPS,
  INTAKE_TRANSCRIPT_MAX_CHARS,
  err,
  factsSummary,
  ensureStaffRoles,
  intakeDraftSchema,
  intakeFactsSchema,
  intakeRepositoryPath,
  intakeStepLogSchema,
  ok,
  type IntakeAnswer,
  type IntakeDraft,
  type IntakeFacts,
  type IntakeRole,
  type IntakeStatus,
  type IntakeStep,
  type IntakeStepEntry,
  type Result,
} from '@slave-of-ai/domain'
import { findPaths, inspectPath } from './detect.js'
import { setGoal } from './goal.js'
import { resolveReposRoot, slugify } from './installation.js'
import { createProjectTeam } from './org.js'
import { assignPerson, createPerson } from './persons.js'
import type { Principal } from './principal.js'
import { refusalText, type ControlRefusal } from './refusal.js'
import { createWorkspace } from './workspace.js'

const execFileAsync = promisify(execFile)

/** A `git` invocation in `initRepository` gets the same ceiling `GitProbe` gives a probe: a repo on
 *  a stuck network mount must fail the verb rather than hang the request. */
const GIT_TIMEOUT_MS = 10_000

/** The identity a first commit is made with when git has none configured (M59 R7). Passed with
 *  `-c` on the one command that needs it and NEVER written into any config: this system does not
 *  edit an operator's git settings. */
const FALLBACK_AUTHOR = 'Slave of AI'
const FALLBACK_EMAIL = 'noreply@slaveofai.local'

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** One line of the conversation as a reader sees it. `createdAt` is an ISO string so a web route
 *  can serialise the view unchanged -- `GoalVersionView`'s own rule. */
export interface IntakeMessageView {
  readonly seq: number
  readonly role: IntakeRole
  readonly text: string
  readonly facts: IntakeFacts | null
  readonly createdAt: string
}

export interface IntakeView {
  readonly id: string
  readonly status: IntakeStatus
  readonly draft: IntakeDraft | null
  readonly messages: readonly IntakeMessageView[]
  readonly stepLog: readonly IntakeStepEntry[]
  readonly workspaceId: string | null
  readonly failureReason: string | null
  /** `INTAKE_MAX_MODEL_CALLS - modelCalls`, floored at zero: what the drawer shows and what the
   *  prompt tells the model it has left. */
  readonly callsLeft: number
  /** The newest `fact` row's structured findings, or null when nothing has been detected yet. */
  readonly facts: IntakeFacts | null
}

/** Parsed rather than cast, the rule `listGoalVersions` states for `origin`: a hand-edited Json
 *  column that will not parse reads back as "nothing here", which every surface can render. */
function parseDraft(value: Prisma.JsonValue | null): IntakeDraft | null {
  if (value === null) return null
  const parsed = intakeDraftSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function parseFacts(value: Prisma.JsonValue | null | undefined): IntakeFacts | null {
  if (value === null || value === undefined) return null
  const parsed = intakeFactsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function parseStepLog(value: Prisma.JsonValue): readonly IntakeStepEntry[] {
  const parsed = intakeStepLogSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

/** The whole conversation (M59 R18's `GET`). One query for the row, one for its messages. */
export async function readIntake(intakeId: string): Promise<Result<IntakeView, ControlRefusal>> {
  const row = await prisma.intake.findUnique({ where: { id: intakeId } })
  if (row === null) return err({ kind: 'intake_not_found', intakeId })
  const messages = await prisma.intakeMessage.findMany({ where: { intakeId }, orderBy: { seq: 'asc' } })
  // The newest fact row that actually CARRIES facts: a discarded-proposal note (R9) is a `fact`
  // row with none, and reading it as "the latest facts" would blank them.
  const latestFacts = messages.reduce<IntakeFacts | null>(
    (found, message) => parseFacts(message.facts) ?? found,
    null,
  )
  return ok({
    id: row.id,
    status: row.status,
    draft: parseDraft(row.draft),
    messages: messages.map((message) => ({
      seq: message.seq,
      role: message.role,
      text: message.text,
      facts: parseFacts(message.facts),
      createdAt: message.createdAt.toISOString(),
    })),
    stepLog: parseStepLog(row.stepLog),
    workspaceId: row.workspaceId,
    failureReason: row.failureReason,
    callsLeft: Math.max(0, INTAKE_MAX_MODEL_CALLS - row.modelCalls),
    facts: latestFacts,
  })
}

// ---------------------------------------------------------------------------------------------
// The conversation (R5, R6, R12)
// ---------------------------------------------------------------------------------------------

/** M59 R5: a row in `open` with no messages. Nothing is spent, nothing is detected and nothing is
 *  asked -- opening the drawer must cost nothing, because most drawers are closed again. */
export async function openIntake(principal?: Principal): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  const row = await prisma.intake.create({ data: { userId: principal?.userId ?? null } })
  return ok({ id: row.id })
}

/** M59 R5. `creating` and `created` refuse: the first is a verb in flight, the second has a project
 *  that abandoning the conversation would not remove. The rows STAY -- the Projects page never
 *  lists intakes, so there is nothing to tidy, and a record of what was asked outlives the asking. */
export async function abandonIntake(intakeId: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> {
  const row = await prisma.intake.findUnique({ where: { id: intakeId }, select: { id: true, status: true } })
  if (row === null) return err({ kind: 'intake_not_found', intakeId })
  const abandonable: readonly IntakeStatus[] = ['open', 'awaiting_reply', 'replying', 'drafted', 'failed']
  if (!abandonable.includes(row.status)) {
    return err({ kind: 'intake_not_abandonable', intakeId, status: row.status })
  }
  // Conditional on the status this read saw, so two abandons racing each other write once.
  await prisma.intake.updateMany({ where: { id: intakeId, status: { in: [...abandonable] } }, data: { status: 'abandoned' } })
  return ok(undefined)
}

/** Everything the model may be told about this installation (M59 R6), gathered once per message.
 *
 *  `active: true` on the catalogue (plan erratum E8): `loadCatalogEntries` already gates the
 *  Supervisor's hiring on that column, and proposing a persona nobody has made hirable would produce
 *  a team `acceptIntake` cannot staff. Name, division and role only -- never a profile body. */
async function installationFacts(): Promise<Omit<IntakeFacts, 'paths'>> {
  const [root, companies, templates] = await Promise.all([
    resolveReposRoot(),
    prisma.company.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 100 }),
    prisma.slaveTemplate.findMany({
      where: { active: true },
      select: { id: true, name: true, sourceDivision: true, role: true },
      orderBy: { name: 'asc' },
      take: INTAKE_CATALOGUE_MAX,
    }),
  ])
  return {
    reposRoot: root.root,
    existingCompanies: companies,
    catalogue: templates.map((template) => ({
      templateId: template.id,
      name: template.name,
      division: template.sourceDivision,
      role: template.role,
    })),
  }
}

/**
 * Everything the model may be told, gathered once per message: what this installation IS, plus what
 * the filesystem says about each path the conversation has named.
 *
 * The split above is load-bearing. The repositories root, the companies and the hirable personas
 * are not discoveries about a folder somebody named -- they are the same whatever the person types
 * -- and gathering them only ALONGSIDE path detection left a brand-new project looking at an empty
 * catalogue while the prompt asked it for a team "from the catalogue below". The only honest answer
 * to that is nobody, which `acceptIntake` records as "the draft asked for nobody": every project
 * not started from an existing local repository arrived unstaffed. `claimIntakes` is where the
 * installation half is now guaranteed, for a conversation that wrote no `fact` row at all.
 */
async function buildFacts(paths: readonly string[]): Promise<IntakeFacts> {
  const [installation, inspected] = await Promise.all([
    installationFacts(),
    Promise.all(paths.map(async (path) => inspectPath(path))),
  ])
  return { paths: inspected, ...installation }
}

async function nextSeq(tx: Prisma.TransactionClient, intakeId: string): Promise<number> {
  const last = await tx.intakeMessage.findFirst({ where: { intakeId }, orderBy: { seq: 'desc' }, select: { seq: true } })
  return (last?.seq ?? -1) + 1
}

/**
 * M59 R6: the person's line, then what detection found, then the turn passes to the daemon.
 *
 * DETECTION RUNS OUTSIDE THE TRANSACTION and before it. It `stat`s directories and spawns `git`,
 * and holding a row lock across that would put a filesystem on a network mount inside a database
 * transaction -- the mistake M31a's two-phase model step exists to avoid, at a smaller scale.
 * The authoritative status and cap checks are then re-made under the lock, BEFORE anything is
 * written, so returning a refusal from the callback cannot commit a half-written message.
 */
export async function sendIntakeMessage(
  intakeId: string,
  text: string,
  _principal?: Principal,
): Promise<Result<{ readonly seq: number }, ControlRefusal>> {
  const message = text.trim()
  if (message === '') return err({ kind: 'invalid_message', reason: 'a message must not be blank' })
  if (message.length > INTAKE_MESSAGE_MAX_CHARS) {
    return err({
      kind: 'invalid_message',
      reason: `a message must be at most ${String(INTAKE_MESSAGE_MAX_CHARS)} characters; this one is ${String(message.length)}`,
    })
  }

  const row = await prisma.intake.findUnique({ where: { id: intakeId } })
  if (row === null) return err({ kind: 'intake_not_found', intakeId })
  if (row.status !== 'open' && row.status !== 'drafted') {
    return err({ kind: 'intake_not_open', intakeId, status: row.status })
  }
  if (row.modelCalls >= INTAKE_MAX_MODEL_CALLS) {
    return err({ kind: 'intake_budget_exhausted', intakeId, calls: row.modelCalls })
  }

  // The draft's own repository path travels back into detection, so a second message about a
  // repository the first one named re-measures it rather than trusting a stale fact row.
  const draft = parseDraft(row.draft)
  const draftPath = draft !== null && draft.repo.path !== null ? [draft.repo.path] : []
  const paths = findPaths(message, draftPath)
  const facts = paths.length === 0 ? null : await buildFacts(paths)
  const summary = facts === null ? '' : factsSummary(facts)

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Intake" WHERE id = ${intakeId} FOR UPDATE`
    const locked = await tx.intake.findUnique({ where: { id: intakeId }, select: { status: true, modelCalls: true } })
    if (locked === null) return { ok: false as const, error: { kind: 'intake_not_found', intakeId } as ControlRefusal }
    if (locked.status !== 'open' && locked.status !== 'drafted') {
      return { ok: false as const, error: { kind: 'intake_not_open', intakeId, status: locked.status } as ControlRefusal }
    }
    if (locked.modelCalls >= INTAKE_MAX_MODEL_CALLS) {
      return { ok: false as const, error: { kind: 'intake_budget_exhausted', intakeId, calls: locked.modelCalls } as ControlRefusal }
    }

    const seq = await nextSeq(tx, intakeId)
    await tx.intakeMessage.create({ data: { intakeId, seq, role: 'human', text: message } })
    if (summary !== '' && facts !== null) {
      await tx.intakeMessage.create({
        data: {
          intakeId,
          seq: seq + 1,
          role: 'fact',
          text: summary,
          facts: facts as unknown as Prisma.InputJsonValue,
        },
      })
    }
    await tx.intake.update({ where: { id: intakeId }, data: { status: 'awaiting_reply' } })
    return { ok: true as const, seq }
  })
  return outcome.ok ? ok({ seq: outcome.seq }) : err(outcome.error)
}

// ---------------------------------------------------------------------------------------------
// The daemon's half (R11)
// ---------------------------------------------------------------------------------------------

export interface ClaimedIntake {
  readonly id: string
  readonly transcript: readonly { readonly role: IntakeRole; readonly text: string }[]
  readonly facts: IntakeFacts | null
  readonly callsLeft: number
}

/**
 * Moves up to `limit` due conversations to `replying` and hands them back (M59 R11).
 *
 * ONE statement, and raw because Prisma's `updateMany` returns a count rather than rows (plan
 * erratum E3). `FOR UPDATE SKIP LOCKED` inside the sub-select is the property two daemons depend
 * on -- D5 makes two normal -- : the second claimer SKIPS a row the first has locked instead of
 * waiting for it, so neither answers the same message and neither blocks.
 *
 * A `replying` row whose claim is older than `INTAKE_CLAIM_TTL_MS` is due again: the process that
 * held it is gone, and a conversation stuck forever behind a dead daemon is the failure this
 * clause exists to prevent.
 */
export async function claimIntakes(input: {
  readonly by: string
  readonly limit: number
  readonly now?: Date
}): Promise<readonly ClaimedIntake[]> {
  if (input.limit <= 0) return []
  const now = input.now ?? new Date()
  const stale = new Date(now.getTime() - INTAKE_CLAIM_TTL_MS)
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Intake" SET "status" = 'replying', "claimedAt" = ${now}, "claimedBy" = ${input.by}
    WHERE "id" IN (
      SELECT "id" FROM "Intake"
      WHERE ("status" = 'awaiting_reply' OR ("status" = 'replying' AND "claimedAt" < ${stale}))
        AND "modelCalls" < ${INTAKE_MAX_MODEL_CALLS}
      ORDER BY "updatedAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    )
    RETURNING "id"`

  const out: ClaimedIntake[] = []
  // Once for the batch, and read HERE rather than taken from the newest `fact` row: the catalogue
  // the model is offered is the one that is hirable now, not the one that happened to be recorded
  // when somebody last named a path -- and a conversation that named no path recorded nothing at
  // all, which is the case that left every new project unstaffed. `paths` stay the conversation's
  // own measurements; nothing here invents one.
  const installation = claimed.length === 0 ? null : await installationFacts()
  for (const { id } of claimed) {
    const view = await readIntake(id)
    if (!view.ok) continue
    out.push({
      id,
      transcript: view.value.messages.map((message) => ({ role: message.role, text: message.text })),
      facts: installation === null ? view.value.facts : { paths: view.value.facts?.paths ?? [], ...installation },
      callsLeft: view.value.callsLeft,
    })
  }
  return out
}

export type IntakeReplyOutcome =
  | {
      readonly kind: 'answer'
      readonly answer: IntakeAnswer
      /** Why a draft became a question, or null (M59 R9). Recorded in the transcript as a `fact`
       *  row so an operator can see why the card they expected did not appear. */
      readonly downgraded: string | null
      readonly costUsd: number | null
    }
  | {
      readonly kind: 'unusable'
      /** Why the answer could not be used (an unparseable reply, an isolation breach). Diagnostic
       *  only -- the caller's own log line, per R11's "writes the `assistant` row" -- and never
       *  written to the transcript: the person sees `UNUSABLE_TEXT`, one sentence they can act on,
       *  not this string. `downgraded` above is the transcript's own note mechanism, and it exists
       *  for the opposite reason -- a draft that WAS produced but broke a source rule, which is
       *  something an operator watching the card should be able to see. */
      readonly reason: string
      readonly costUsd: number | null
    }
  | {
      /**
       * The call never came back with an answer at all: a spawn failure, a timeout, an API that
       * refused. Separate from `unusable` because the two need OPPOSITE sentences. An unusable
       * answer was read and could not be understood, so asking the person to say more is the useful
       * next step; an unreachable model never read the message, so the same invitation is false --
       * it blames the person for a sentence nobody saw, and every rephrasing spends another of the
       * twelve calls the conversation is allowed on a condition rephrasing cannot fix.
       */
      readonly kind: 'unreachable'
      /** Why the call produced nothing. UNLIKE `unusable`'s reason this one DOES reach the
       *  transcript, as a `fact` row: a person watching a drawer go quiet has no other way to learn
       *  that the failure was not theirs, and stderr is not somewhere they can look. */
      readonly reason: string
      readonly costUsd: number | null
    }

/** What the conversation says when the model's answer could not be read at all. The person is not
 *  told about JSON: they are asked to say a little more, which is the only useful next step. */
const UNUSABLE_TEXT = 'Sorry — I did not follow that. Could you say a little more about what you want to build?'

/** What the conversation says when the model could not be reached. It says the message was not
 *  read, because it was not, and it does not ask for a rewrite of something nobody saw. */
const UNREACHABLE_TEXT =
  'Sorry — I could not reach the model, so your message has not been read yet. Nothing you wrote was the problem.'

/**
 * Writes what one model call produced (M59 R11): the assistant's line, the new status, the draft
 * if there is one, the money, and the released claim -- in one transaction, so a reader never sees
 * a conversation whose status says `drafted` and whose draft is not there yet.
 *
 * The call is charged whatever the answer turned out to be. An unusable answer cost money.
 *
 * ONLY THE DAEMON THAT STILL HOLDS THE CLAIM MAY WRITE (fix round 1): the row is re-read for its
 * STATUS under the same `FOR UPDATE` lock `sendIntakeMessage` takes, and a status other than
 * `replying` refuses `intake_not_open` before anything is written. Without this, an abandon that
 * landed while a reply was in flight would be silently undone by the reply that lands after it, an
 * accept that claimed `creating` would be overwritten back to `open`/`drafted`, and a claim
 * reclaimed after its TTL could be answered twice -- two `assistant` rows and two charges for one
 * turn. Nothing has been written yet at that point, so a plain `return` (not a `throw`) is correct.
 */
export async function recordIntakeReply(
  intakeId: string,
  outcome: IntakeReplyOutcome,
): Promise<Result<void, ControlRefusal>> {
  const answerText =
    outcome.kind === 'answer' ? outcome.answer.text : outcome.kind === 'unreachable' ? UNREACHABLE_TEXT : UNUSABLE_TEXT
  const draft = outcome.kind === 'answer' && outcome.answer.kind === 'draft' ? outcome.answer.draft : null
  // `unusable`'s `reason` is not a note (see the field's own docstring): the transcript's last row
  // for an answer nobody could use is the sentence the person reads, not a fact row that would sit
  // after it and say something like "A proposal was discarded: the answer could not be read" --
  // there was no proposal to discard.
  //
  // `unreachable`'s reason IS a note, and for the note mechanism's own reason: the sentence above
  // says the model could not be reached without saying why, and "why" is the difference between a
  // person waiting out a passing outage and one waiting out an exhausted account forever.
  // Whole sentences rather than a fragment and a prefix chosen at the write site: the two notes
  // describe different things, and one shared `A proposal was discarded:` would be a lie on the
  // unreachable path, where no proposal was ever made.
  const note =
    outcome.kind === 'answer'
      ? outcome.downgraded === null || outcome.downgraded === ''
        ? null
        : `A proposal was discarded: ${outcome.downgraded}`
      : outcome.kind === 'unreachable'
        ? `The model could not be reached: ${outcome.reason}`
        : null

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Intake" WHERE id = ${intakeId} FOR UPDATE`
    const row = await tx.intake.findUnique({ where: { id: intakeId }, select: { status: true } })
    if (row === null) return { ok: false as const, error: { kind: 'intake_not_found', intakeId } as ControlRefusal }
    if (row.status !== 'replying') {
      return { ok: false as const, error: { kind: 'intake_not_open', intakeId, status: row.status } as ControlRefusal }
    }
    const seq = await nextSeq(tx, intakeId)
    await tx.intakeMessage.create({ data: { intakeId, seq, role: 'assistant', text: answerText } })
    if (note !== null) {
      await tx.intakeMessage.create({ data: { intakeId, seq: seq + 1, role: 'fact', text: note } })
    }
    await tx.intake.update({
      where: { id: intakeId },
      data: {
        status: draft === null ? 'open' : 'drafted',
        ...(draft === null ? {} : { draft: draft as unknown as Prisma.InputJsonValue }),
        claimedAt: null,
        claimedBy: null,
        modelCalls: { increment: 1 },
        ...(outcome.costUsd === null
          ? { unmeasuredCalls: { increment: 1 } }
          : { modelCostUsd: { increment: outcome.costUsd } }),
      },
    })
    return { ok: true as const }
  })
  return result.ok ? ok(undefined) : err(result.error)
}

// ---------------------------------------------------------------------------------------------
// A repository that did not exist (R7)
// ---------------------------------------------------------------------------------------------

async function git(cwd: string, args: readonly string[], extra: readonly string[] = []): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...extra, ...args], { timeout: GIT_TIMEOUT_MS })
}

/** Whether git has an identity it would sign a commit with here. `git var GIT_AUTHOR_IDENT` is the
 *  question git asks itself and it FAILS when there is none, which is exactly the answer wanted. */
async function hasGitIdentity(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', cwd, 'var', 'GIT_AUTHOR_IDENT'], { timeout: GIT_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

/**
 * M59 R7: a repository for a project that has only an idea.
 *
 * Runs in whichever process calls it, which for the web is the web process -- the same trust
 * `createWorkspace` extends when it `stat`s any path the operator names (`workspace.ts:148`) and
 * `GitProbe` extends when it runs `git rev-parse` there. It writes inside ONE directory that it
 * created, under a path the operator gave.
 *
 * The README is not decoration: it is what makes the first commit a commit, and `## Goal` is where
 * the goal text lands so a person opening the folder in an editor can see what the project is for.
 */
export async function initRepository(input: {
  readonly path: string
  readonly name: string
  readonly goal: string
}): Promise<Result<{ readonly path: string; readonly baseBranch: string }, ControlRefusal>> {
  const { path, name, goal } = input
  if (!isAbsolute(path)) return err({ kind: 'repo_path_not_absolute', path })

  const parent = dirname(path)
  const parentInfo = await stat(parent).catch(() => null)
  if (parentInfo === null || !parentInfo.isDirectory()) return err({ kind: 'parent_not_found', path })

  const info = await stat(path).catch(() => null)
  if (info !== null) {
    if (!info.isDirectory()) return err({ kind: 'path_not_empty', path })
    const entries = await readdir(path).catch(() => null)
    if (entries === null || entries.length > 0) return err({ kind: 'path_not_empty', path })
  }

  // Asked of the PARENT, because the path itself may not exist yet.
  const inside = await execFileAsync('git', ['-C', parent, 'rev-parse', '--is-inside-work-tree'], { timeout: GIT_TIMEOUT_MS })
    .then((result) => result.stdout.trim() === 'true')
    .catch(() => false)
  if (inside) return err({ kind: 'inside_repository', path })

  try {
    await mkdir(path, { recursive: true })
    await git(path, ['init', '-q', '-b', 'main'])
    await writeFile(join(path, 'README.md'), `# ${name}\n\n## Goal\n\n${goal}\n`, 'utf8')
    await git(path, ['add', 'README.md'])
    const identity = (await hasGitIdentity(path))
      ? []
      : ['-c', `user.name=${FALLBACK_AUTHOR}`, '-c', `user.email=${FALLBACK_EMAIL}`]
    await git(path, ['commit', '-q', '-m', `chore: begin ${name}`], identity)
  } catch (error) {
    return err({ kind: 'repo_init_failed', path, reason: error instanceof Error ? error.message : String(error) })
  }
  return ok({ path, baseBranch: 'main' })
}

// ---------------------------------------------------------------------------------------------
// Accept (R10)
// ---------------------------------------------------------------------------------------------

async function appendStep(intakeId: string, entry: IntakeStepEntry): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.intake.findUnique({ where: { id: intakeId }, select: { stepLog: true } })
    if (row === null) return
    const log = [...parseStepLog(row.stepLog), entry]
    await tx.intake.update({
      where: { id: intakeId },
      data: { stepLog: log as unknown as Prisma.InputJsonValue },
    })
  })
}

/** The human half of the conversation, joined and capped -- what `setGoal` records as the REQUEST
 *  so the project's Supervisor conversation opens with the words the person actually typed (M57 R9
 *  groups `workspace.goal_set` into threads). */
function transcriptSummary(messages: readonly IntakeMessageView[]): string {
  return messages
    .filter((message) => message.role === 'human')
    .map((message) => message.text)
    .join('\n')
    .slice(0, INTAKE_TRANSCRIPT_MAX_CHARS)
}

/**
 * M59 R10: the steps, in order, each recorded before the next one starts.
 *
 * WHY A LOG AND NOT A TRANSACTION. Two of these steps are not database writes at all -- one makes a
 * directory and a commit, one will spawn nothing but writes rows in another verb -- and a
 * transaction cannot roll back a `git init`. So the shape is the honest one: do a step, record it,
 * move on; a failure stops and says where. A second accept RESUMES at the first step that is not
 * `done`, which is safe because every step it re-runs is either a refusal it can read
 * (`duplicate_name`, `path_not_empty`) or a verb that is safe to repeat.
 *
 * `workspaceId` is written as soon as `create_workspace` succeeds rather than at the end: it is
 * what the card links to when a later step failed, and what a resume continues from.
 */
export async function acceptIntake(
  intakeId: string,
  draftInput: unknown,
  principal?: Principal,
): Promise<Result<{ readonly workspaceId: string }, ControlRefusal>> {
  const view = await readIntake(intakeId)
  if (!view.ok) return view
  const intake = view.value
  if (intake.status === 'creating') return err({ kind: 'intake_busy', intakeId })
  if (intake.status === 'created') {
    return err({ kind: 'intake_already_created', intakeId, workspaceId: intake.workspaceId ?? '' })
  }
  if (intake.status === 'abandoned') return err({ kind: 'intake_not_open', intakeId, status: intake.status })

  const parsed = intakeDraftSchema.safeParse(draftInput)
  if (!parsed.success) {
    return err({ kind: 'invalid_draft', detail: parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ') })
  }
  const draft = parsed.data

  // R8's second half: an EXISTING repository must be one a `fact` row really reported as a
  // repository. The model cannot invent a path, and neither can an edited card.
  if (draft.repo.mode === 'existing') {
    const reported = (intake.facts?.paths ?? []).some((path) => path.path === draft.repo.path && path.isRepository)
    if (!reported) {
      return err({ kind: 'invalid_draft', detail: `${draft.repo.path ?? ''} was never reported as a git repository in this conversation` })
    }
  }

  // R8's verify-command half: every command must carry a source it is entitled to (spec R8). The
  // "detected" set is built ONLY from the facts entry for the repository THIS DRAFT CHOSE -- a
  // command really found in some OTHER path this conversation looked at is not evidence for this
  // one, and a `new` repository has nothing detected at all, because there is nothing there yet to
  // have found anything in. `draft` (the model's own proposal for a stack it was told about) is
  // only legal for a repository that does not exist yet. `operator` needs no check: the person
  // typed it into the card themselves. Checked here, not just at draft time (`draftBreach` in the
  // domain), because a person can EDIT the card before accepting it, and an edited card is a new
  // claim that has not been through that check.
  const chosenRepoVerify =
    draft.repo.mode === 'existing'
      ? new Set(
          (intake.facts?.paths ?? [])
            .find((path) => path.path === draft.repo.path)
            ?.verify.map((finding) => finding.command) ?? [],
        )
      : new Set<string>()
  for (const entry of draft.verifyCommands) {
    if (entry.source === 'detected' && !chosenRepoVerify.has(entry.command)) {
      return err({
        kind: 'invalid_draft',
        detail: `"${entry.command}" is marked as detected but was not found in the repository this project uses`,
      })
    }
    if (entry.source === 'draft' && draft.repo.mode !== 'new') {
      return err({
        kind: 'invalid_draft',
        detail: `"${entry.command}" is marked as a proposal, and this project uses a repository that already exists`,
      })
    }
  }

  // The claim: `creating` is taken conditionally, so a second accept arriving here refuses
  // `intake_busy` rather than running the steps a second time.
  const claimed = await prisma.intake.updateMany({
    where: { id: intakeId, status: { in: ['open', 'awaiting_reply', 'replying', 'drafted', 'failed'] } },
    data: { status: 'creating', failureReason: null },
  })
  if (claimed.count === 0) return err({ kind: 'intake_busy', intakeId })

  const done = new Map(intake.stepLog.filter((entry) => entry.status !== 'failed').map((entry) => [entry.step, entry]))
  const now = (): string => new Date().toISOString()
  const fail = async (step: IntakeStep, refusal: ControlRefusal): Promise<Result<never, ControlRefusal>> => {
    const reason = refusalText(refusal)
    await appendStep(intakeId, { step, status: 'failed', at: now(), detail: reason })
    await prisma.intake.update({ where: { id: intakeId }, data: { status: 'failed', failureReason: reason } })
    return err(refusal)
  }

  // THE CLAIM IS TAKEN: from here on an exception that escapes a step must not leave the intake
  // stranded in `creating` forever (fix round 1) -- `intake_busy` for every later accept,
  // `intake_not_abandonable` for `abandonIntake`, `intake_not_open` for `sendIntakeMessage`, none
  // of them a way out. `currentStep` names which step was running when a step's own dependency
  // THREW instead of returning a `Result` -- a dropped connection, anything its type does not
  // carry -- so an unexpected throw still reaches `fail()` and lands the intake in `failed`,
  // exactly where a step that returned a refusal would have put it: resumable, abandonable.
  let currentStep: IntakeStep = 'init_repository'
  try {
    // 1. init_repository -- only when there is no repository yet.
    let repoPath = draft.repo.path
    if (draft.repo.mode === 'new') {
      const already = done.get('init_repository')
      if (already !== undefined && already.detail !== null) {
        repoPath = already.detail
      } else {
        const root = await resolveReposRoot()
        const target = draft.repo.path ?? intakeRepositoryPath(root.root, slugify(draft.name))
        const created = await initRepository({ path: target, name: draft.name, goal: draft.goal })
        if (!created.ok) return fail('init_repository', created.error)
        repoPath = created.value.path
        await appendStep(intakeId, { step: 'init_repository', status: 'done', at: now(), detail: created.value.path })
      }
    }
    if (repoPath === null) {
      return fail('create_workspace', { kind: 'invalid_draft', detail: 'this project has no repository path' })
    }

    // 2. create_workspace.
    currentStep = 'create_workspace'
    let workspaceId = intake.workspaceId
    if (done.get('create_workspace') === undefined || workspaceId === null) {
      const created = await createWorkspace(
        {
          name: draft.name,
          repoPath,
          baseBranch: draft.baseBranch,
          verifyCommands: draft.verifyCommands.map((entry) => entry.command),
          setupCommands: [...draft.setupCommands],
          budgetUsd: draft.budgetUsd,
          provider: draft.provider,
        },
        principal,
        { intakeId },
      )
      if (!created.ok) return fail('create_workspace', created.error)
      workspaceId = created.value.id
      // Written NOW, not at `mark_created`: the card links a half-created project to the project
      // that exists, and a resume continues from it.
      await prisma.intake.update({ where: { id: intakeId }, data: { workspaceId } })
      await appendStep(intakeId, { step: 'create_workspace', status: 'done', at: now(), detail: workspaceId })
    }

    // 3. staff -- M59 R13. The seats the draft named, with `manager` and `reviewer` guaranteed among
    //    them, on ONE department named after the project.
    //
    //    A workspace starts with no `Team` at all (`createWorkspace` writes one row and at most one
    //    `ProviderConfiguration`), so the department is created here, with the verb that already
    //    exists for it -- `createProjectTeam`, which emits the `org.changed` every other project-level
    //    org verb emits.
    //
    //    A seat that cannot be opened FAILS the step rather than being skipped: a project staffed
    //    with half the team the person approved is worse than one that says it stopped, and the
    //    resume path re-runs `staff` from the beginning. `createPerson` and `assignPerson` are M58's
    //    (R10); the roles are what `ensureStaffRoles` settled.
    currentStep = 'staff'
    if (done.get('staff') === undefined) {
      // The live catalogue, for `claimIntakes`' reason: the division heuristic that decides WHICH
      // seat carries manager and reviewer reads it, and a conversation that never named a path has
      // no `fact` row to take it from.
      const seats = ensureStaffRoles(draft.team, (await installationFacts()).catalogue)
      if (seats.length === 0) {
        await appendStep(intakeId, {
          step: 'staff',
          status: 'skipped',
          at: now(),
          detail: 'the draft asked for nobody',
        })
      } else {
        const createdTeam = await createProjectTeam(workspaceId, draft.name, principal)
        let teamId: string
        if (createdTeam.ok) {
          teamId = createdTeam.value.id
        } else {
          if (createdTeam.error.kind !== 'duplicate_name') return fail('staff', createdTeam.error)
          const existing = await prisma.team.findFirst({
            where: { workspaceId, name: draft.name },
            select: { id: true },
          })
          if (existing === null) return fail('staff', createdTeam.error)
          teamId = existing.id
        }
        for (const seat of seats) {
          const alreadyOpen = await prisma.slave.findFirst({
            where: { teamId, closedAt: null, person: { templateId: seat.templateId } },
            select: { id: true },
          })
          if (alreadyOpen !== null) continue
          const person = await createPerson({ templateId: seat.templateId }, principal)
          if (!person.ok) return fail('staff', person.error)
          const assigned = await assignPerson(
            person.value.personId,
            teamId,
            { runtimeRoles: [...seat.runtimeRoles] },
            principal,
          )
          if (!assigned.ok) return fail('staff', assigned.error)
        }
        await appendStep(intakeId, {
          step: 'staff',
          status: 'done',
          at: now(),
          detail: `${String(seats.length)} seat(s) on ${draft.name}`,
        })
      }
    }

    // 4. set_goal -- with the person's own words as the request.
    currentStep = 'set_goal'
    if (done.get('set_goal') === undefined) {
      const goal = await setGoal(workspaceId, draft.goal, principal, { request: transcriptSummary(intake.messages) })
      if (!goal.ok) return fail('set_goal', goal.error)
      await appendStep(intakeId, { step: 'set_goal', status: 'done', at: now(), detail: `v${String(goal.value.version)}` })
    }

    // 5. mark_created.
    currentStep = 'mark_created'
    await appendStep(intakeId, { step: 'mark_created', status: 'done', at: now(), detail: null })
    await prisma.intake.update({ where: { id: intakeId }, data: { status: 'created', workspaceId, failureReason: null } })
    return ok({ workspaceId })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return fail(currentStep, { kind: 'accept_step_failed', step: currentStep, reason })
  }
}

/** The five steps, exported as data for the surfaces that render a log with the steps that have
 *  not run yet greyed out. `INTAKE_STEPS` is the domain's copy and this is a re-export rather than
 *  a second list. */
export { INTAKE_STEPS }
