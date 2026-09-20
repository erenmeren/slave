import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import {
  CHAT_ATTACHMENT_CHARS,
  CHAT_FEED_MAX,
  CHAT_MESSAGE_MAX_CHARS,
  SITUATION_LABEL,
  SUPERVISOR_PER_CALL_CAP_USD,
  buildSupervisorChatPrompt,
  isSourced,
  parseSupervisorReply,
  renderedChatSources,
  tierOf,
  verifySources,
  type Action,
  type ChatAttachment,
  type ChatTurnInput,
  type SupervisorWorld,
  type Tier,
} from '@slave-of-ai/domain'
import { detachedCalls } from './detachedCalls.js'
import { recentFeed } from './feed.js'
import { chatTurnFilePaths } from './paths.js'
import { writePermissionsFile } from './permission.js'
import { plural } from './plural.js'
import { refusalText } from './refusal.js'
import { DEFAULT_MAX_MODEL_CALLS } from './simulation/auto-run.js'
import type { DeciderRegistry, ModelDecider, ModelOutcome } from './simulation/llm.js'
import { applyDecision, listDecisions, recordDecision } from './supervisor.js'
import {
  claimSupervisorTurns,
  recordSupervisorReply,
  type ClaimedSupervisorTurn,
  type SupervisorMessageAction,
} from './supervisorChat.js'
import { isInboxPath } from './supervisorUploads.js'
import { loadSupervisorWorld } from './supervisorWorld.js'

/**
 * The chat turns this PROCESS has started and not yet recorded, keyed by the placeholder's id.
 *
 * ITS OWN set, from the shared factory (fix round 1, I3): `tickIntakes` keeps a separate one, so
 * the chat's concurrency cap never counts intake calls and a chat drain never waits for an intake
 * reply. Everything about why it is this PROCESS's set is in {@link detachedCalls}.
 *
 * The stored promise NEVER rejects: the whole body of {@link startChatTurn} is caught.
 */
const calls = detachedCalls()

/** The chat turns whose model call this process started and has not recorded. A copy. */
export function inFlightSupervisorChat(): ReadonlySet<string> {
  return calls.inFlight()
}

/** Waits for every detached chat turn to finish recording. The daemon awaits this on shutdown:
 *  recording is a database write for a call the account has already been billed for, so
 *  disconnecting Prisma out from under one would lose exactly the row that must not be lost. */
export async function drainSupervisorChatCalls(): Promise<void> {
  await calls.drain()
}

/** What one pass did. `due` counts the turns waiting for a reply when the pass began -- which is
 *  the number an operator needs when `skippedInFlight` is non-zero. */
export interface TickSupervisorChatReport {
  readonly due: number
  readonly startedModelCalls: number
  readonly skippedInFlight: number
}

/** The reason a turn fails when the workspace names a provider this daemon holds no decider for
 *  (controller ruling 1). A WORD rather than a sentence: it is matched by the orchestrator's own
 *  tests and by the gate, and it reaches the panel through `failureReason` where the panel says
 *  what it means. */
export const NO_DECIDER_REASON = 'no_decider_for_provider'

/** The reason a turn fails when the project has spent its budget (fix round 1, I2b). A word, like
 *  {@link NO_DECIDER_REASON}, and the panel says what it means. */
export const BUDGET_EXHAUSTED_REASON = 'budget_exhausted'

/**
 * What is waiting on a PERSON, as sentences the prompt lists under NEEDS YOU (F R2).
 *
 * NOT `apps/web/src/server/needsYou.ts`: that function is the panel's queue and reaches its
 * `question` items through `buildSupervisorView`, a web-only loader, and its task items through
 * `Workspace.autoMerge` and a task read of its own. Moving it into control is its own piece of
 * work and would drag the Supervisor VIEW with it, so this is the subset that is honestly
 * derivable here and the difference is stated rather than hidden:
 *
 * - every PENDING decision, titled exactly as the bar titles it (`SITUATION_LABEL` + the
 *   situation's own summary), because a proposed action is the thing a person most often has to
 *   answer and it is the thing a conversation is most likely to be asked about;
 * - every open question NOBODY BUT A PERSON can answer (`holders.length === 0`), which is the
 *   bar's own rule for a `question` item.
 *
 * What it does NOT carry, and the panel's bar does: blocked tasks and tasks waiting to be
 * integrated. Both are on the BOARD digest the same prompt renders two sections above, with their
 * status and how long they have been in it, so the model is not blind to them -- it just does not
 * see them called out as "waiting on you".
 */
export async function needsYouSummaries(workspaceId: string, world: SupervisorWorld): Promise<readonly string[]> {
  const decisions = await listDecisions(workspaceId, { pending: true })
  const nameOf = (slaveId: string): string => world.slaves.find((one) => one.id === slaveId)?.name ?? slaveId
  return [
    ...decisions.map((decision) => `${SITUATION_LABEL[decision.situationKind]}: ${decision.situation.summary}`),
    ...world.questions
      .filter((question) => question.holders.length === 0)
      .map((question) => `${nameOf(question.askerSlaveId)} asked: ${question.body}`),
  ]
}

/**
 * The attachments as the PROMPT will be given them: each text file's contents read off the
 * repository, everything else named and nothing more (F R6).
 *
 * The per-file cap is applied HERE as well as in the prompt, and for a different reason: the
 * prompt's cap decides what the model is shown, and this one decides how much of a twenty-megabyte
 * file is ever held in this process's memory. The TOTAL budget is the prompt's alone
 * (`inlineAttachments`), because only it knows what each file's slice cost after defusing.
 *
 * A file that cannot be read gets NO `text`, which the prompt renders as "could not be read" --
 * never as an empty file. The two are different facts about the same path and a model reasoning
 * from the wrong one would tell the person their brief was blank.
 */
async function readAttachmentText(
  repoPath: string,
  attachments: readonly ChatAttachment[],
): Promise<readonly ChatAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment): Promise<ChatAttachment> => {
      if (attachment.kind !== 'text') return attachment
      // THE SAME CHECK `sendSupervisorMessage` APPLIES ON THE WAY IN, applied again on the way out
      // (fix round 1, I4). `attachments` is a `Json` column: a row written by a future version, a
      // hand-edited one, or one from a build whose rule differed can carry any path at all, and
      // this function would have opened it with the daemon's own rights and inlined it into a
      // prompt. A stored path that is not a file directly under `docs/inbox/` is simply not read,
      // and the prompt then lists it as one it could not read -- which is true of it.
      if (!isInboxPath(attachment.path)) return attachment
      try {
        const text = await readFile(join(repoPath, ...attachment.path.split('/')), 'utf8')
        return { ...attachment, text: text.slice(0, CHAT_ATTACHMENT_CHARS) }
      } catch {
        return attachment
      }
    }),
  )
}

/**
 * Arms ONE read-only turn and makes the call (F R7, erratum E2).
 *
 * A 32-byte token minted here and written down nowhere: the file carries only its sha256
 * (`writePermissionsFile`), so pointing this child at another turn's verdict would buy nothing.
 * The verdict itself is the baseline of a PLANNING run -- `read_repo` and nothing else.
 *
 * WHY `planning` AND NOT `review`: the controller's ruling named `review` as "the read-only
 * baseline" and, in the same breath, required a test proving the file grants `read_repo` and
 * nothing else. `BASELINE_GRANTS.review` is `['read_repo', 'run_commands']`; `planning`'s is
 * `['read_repo']`. Only one of those two can be true, and the spec's own R7 says
 * "`runKind: 'planning'`'s baseline". A turn that exists to let the model OPEN A PICTURE has no
 * business being able to run a command, so `planning` it is, and the test holds it there.
 *
 * WHAT THIS DOES NOT BUY (erratum E2, said again where it is armed): `read_repo` is a grant by
 * KIND, not by path. The gate resolves a tool to a `PermissionKind` and asks whether that kind is
 * granted; it has no notion of a path. So this turn may `Read` any file the daemon's own user can
 * read -- not only the attachment, and not only files under `cwd`. What narrows it is the prompt
 * and the cwd, which are guidance, not a boundary.
 */
async function readOnlyCall(
  decider: ModelDecider,
  input: { readonly model: string; readonly prompt: string; readonly messageId: string; readonly repoPath: string },
): Promise<ModelOutcome> {
  const { turnDir } = chatTurnFilePaths(input.repoPath, input.messageId)
  const runToken = randomBytes(32).toString('hex')
  const permissionsFilePath = writePermissionsFile(turnDir, {
    // No worker, so no matrix: a chat turn is not somebody's run and there is no `Slave` whose
    // permissions could widen or narrow it. The baseline is the whole verdict.
    rows: [],
    provider: 'claude_code',
    runKind: 'planning',
    // The turn's own id where a run's would go. `runId` is what the gate compares the token's
    // hash against, and it is written into the file rather than looked up anywhere.
    runId: input.messageId,
    runToken,
  })
  return decider({
    model: input.model,
    prompt: input.prompt,
    maxBudgetUsd: SUPERVISOR_PER_CALL_CAP_USD,
    tools: 'read-only',
    cwd: input.repoPath,
    permissionsFilePath,
    runToken,
  })
}

/**
 * Every action one reply asked for, recorded as a decision and applied at the tier the rules give
 * it (F R3).
 *
 * The conversation borrows the Supervisor's authority and gets none of its own: each action
 * becomes an ordinary `SupervisorDecision` under `operator_request`, with a catalogue of exactly
 * the one action the reply named. `tierOf` under E's switch then says whether it is carried out
 * now or waits in the needs-you bar; nothing here decides that.
 *
 * THE SUBJECT IS `<messageId>:<actionKind>`, NOT THE MESSAGE ID ALONE, and the reason is
 * `recordDecision`'s own idempotence rule: `(workspaceId, situationKind, subjectId)` is a KEY, an
 * open decision on it blocks a second, and a resolved one cools it for `COOLDOWN_MS`. With the
 * bare message id, a reply that asked for two things would record the first and have the second
 * refused `supervisor_cooldown` -- one of the two things the person asked for would silently not
 * happen. The message id is the prefix (so a row is still findable from the turn) and
 * `facts.messageId` carries it exactly; the panel finds a reply's cards through
 * `SupervisorMessage.actions`, which stores each `decisionId`, rather than by this key. Two
 * actions of the SAME kind in one reply still collide, which is right: that is a model repeating
 * itself, and the second is dropped rather than doubled.
 *
 * AN ACTION WHOSE DECISION IS REFUSED GETS A SENTENCE (fix round 1, I1). A cooldown, a Supervisor
 * switched off, a second action of the same kind in one reply -- each of those means the person
 * asked for something and it did not happen, and dropping it into stderr left the reply reading as
 * though it had. The sentence joins the SAME `notes` the parser's dropped-action sentences and the
 * citation verdict use, so a person reads one list of "what did not happen" under the answer. The
 * turn still answers: a refusal to record is never a reason to withhold what the model said, and a
 * person whose Supervisor is switched off may be asking exactly why nothing is happening.
 *
 * A refused APPLY is different and keeps its old treatment: it is a `failed` decision row with its
 * reason, which `applyDecision` writes and the panel shows, so the action stays in the list --
 * it DID become a decision, and the card a person sees carries the failure.
 */
async function recordReplyActions(
  turn: ClaimedSupervisorTurn,
  actions: readonly Action[],
  world: SupervisorWorld,
): Promise<{ readonly recorded: readonly SupervisorMessageAction[]; readonly notes: readonly string[] }> {
  const recorded: SupervisorMessageAction[] = []
  const notes: string[] = []
  for (const action of actions) {
    const tier: Tier = tierOf(action, world, 'operator_request')
    const decision = await recordDecision({
      workspaceId: turn.workspaceId,
      situation: {
        kind: 'operator_request',
        subjectId: `${turn.id}:${action.kind}`,
        // The person's own message is what the decision was made ABOUT, and it is what a reader
        // months later needs to judge it. Capped at the length the prompt carried it at, so the
        // stored summary can never be longer than what the model was actually shown.
        summary: turn.message.slice(0, CHAT_MESSAGE_MAX_CHARS),
        facts: { messageId: turn.id, actionKind: action.kind },
      },
      candidates: [{ action, tier, why: 'asked for in the conversation' }],
      chosenIndex: 0,
      rationale: 'the person asked for this in the conversation',
      decidedBy: 'model',
      // The turn's cost belongs to the TURN, not to each action it produced. `modelCalled` is the
      // question "is a model call BILLABLE HERE", not "did a model write this": `workspaceSpend`
      // charges every `modelCalled` row with no cost at `SUPERVISOR_PER_CALL_CAP_USD`, and the
      // turn's call is already charged there once, on the `SupervisorMessage` row (fix round 1,
      // I2a). `true` here would bill the same call again, once per action the reply asked for.
      modelCostUsd: null,
      modelCalled: false,
      // A FRESH stamp, not the pass's (fix round 1, M1): this runs after a model call that can
      // take a minute, and `recordDecision` writes `createdAt` from it -- which is the anchor its
      // own cooldown is measured from. A decision stamped a minute in the past is a decision
      // whose cooldown is already a minute spent.
      now: new Date(),
    })
    if (!decision.ok) {
      const reason = refusalText(decision.error)
      process.stderr.write(`[chat] ${turn.id}: an action was not recorded — ${reason}\n`)
      // The VERB in the person's words, not the action's `kind`: they asked for a goal change,
      // not for a `request_goal_change`. `docs/ia.md` rule 3, at the one place the catalogue's
      // vocabulary would otherwise reach a reply.
      notes.push(`I could not record ${ASKED_FOR[action.kind]}: ${reason}`)
      continue
    }
    if (decision.value.tier === 'applied') {
      const applied = await applyDecision(decision.value.id, 'system')
      if (!applied.ok) process.stderr.write(`[chat] ${turn.id}: ${refusalText(applied.error)}\n`)
    }
    recorded.push({ action, decisionId: decision.value.id, tier: decision.value.tier })
  }
  return { recorded, notes }
}

/**
 * What the person asked for, per action kind, as a noun phrase that reads after "I could not
 * record " (fix round 1, I1).
 *
 * A total `Record<ActionKind, string>`, so a twenty-third action kind fails the build here rather
 * than putting `note_for_planner` in front of somebody in a sentence about their own project.
 */
const ASKED_FOR: Readonly<Record<Action['kind'], string>> = {
  unblock_task: 'unblocking that task',
  raise_max_attempts: 'giving that task another attempt',
  set_runtime_roles: 'that change to what somebody does here',
  assign_capability: 'giving somebody that capability',
  materialise_company_worker: 'seating somebody on this project',
  hire_from_catalog: 'hiring somebody',
  adopt_runbook: 'adopting that way of working',
  answer_question: 'answering that question',
  reassign_question: 'sending that question to somebody else',
  mark_task_failed: 'marking that task failed',
  cancel_task: 'cancelling that task',
  discard_stale_candidates: 'withdrawing those unchecked reports',
  release_worker: 'releasing that worker',
  steer_run: 'steering that run',
  request_permission: 'asking for that permission',
  retry_task: 'retrying that task',
  retry_review: 'sending that task back through review',
  clear_halt: 'clearing the halt',
  request_goal_change: 'that change to the goal',
  note_for_planner: 'that note for the planner',
  escalate_to_human: 'raising that with a person',
  no_action: 'doing nothing',
}

/**
 * One claimed turn's call, started and NOT awaited -- `startIntakeCall`'s shape (M59 R14, the
 * shape M32 item 2 gave the simulations). Everything after the call -- the parse, the source
 * check, the decisions, the record, removing the id from the in-flight set -- happens when the
 * promise settles.
 *
 * Nothing thrown in here escapes: a decider that rejects (the CLI died, the spawn failed) becomes
 * a `failed` turn, which is recorded and charged like any other, because the money was spent
 * either way. A turn is never left in `answering` by a throw -- and if the process dies before
 * this settles, `SUPERVISOR_CHAT_CLAIM_TTL_MS` is what frees the row.
 */
function startChatTurn(
  turn: ClaimedSupervisorTurn,
  deciders: DeciderRegistry,
  defaultModel: string,
  now: Date,
): void {
  const settled = (async (): Promise<void> => {
    try {
      const provider = turn.provider ?? 'claude_code'
      const decider: ModelDecider | undefined = deciders[provider]
      if (decider === undefined) {
        // Ruling 1: the workspace names a runtime this daemon cannot call. ONE turn fails, with a
        // reason an operator can act on, rather than the pass claiming rows it cannot answer.
        await settle(turn.id, { kind: 'failed', reason: NO_DECIDER_REASON, costUsd: null, unmeasured: false })
        return
      }

      const workspace = await prisma.workspace.findUnique({
        where: { id: turn.workspaceId },
        select: { repoPath: true },
      })
      if (workspace === null) {
        await settle(turn.id, { kind: 'failed', reason: 'this project no longer exists', costUsd: null, unmeasured: false })
        return
      }

      const { world, settings } = await loadSupervisorWorld(turn.workspaceId, now)
      // I2b: THE BUDGET GATE, and it is the same one that stops every other Supervisor call --
      // `world.budgetExhausted` is `workspaceStats`' verdict, which now counts this conversation's
      // own turns (I2a). A project past its budget does not get to keep talking its way further
      // past it, and the turn says so rather than going quiet.
      //
      // A HALTED project still chats, deliberately: a halt is exactly when a person asks "why is
      // nothing running?", and the one surface that could answer that is this one. `tierOf` already
      // refuses to apply anything under a halt, so a conversation on a halted project costs one
      // call and changes nothing.
      if (world.budgetExhausted) {
        await settle(turn.id, { kind: 'failed', reason: BUDGET_EXHAUSTED_REASON, costUsd: null, unmeasured: false })
        return
      }
      const [feed, attachments] = await Promise.all([
        recentFeed(turn.workspaceId, CHAT_FEED_MAX),
        readAttachmentText(workspace.repoPath, turn.attachments),
      ])
      const needsYou = await needsYouSummaries(turn.workspaceId, world)
      // R7: only `claude_code` can be spawned with tools at all, and only a turn that has an image
      // to open has anything to spawn them for. A Cursor turn is always text-only (its gate denies
      // everything), and `imagesReadable: false` is what stops the prompt offering to open a
      // picture the call cannot open.
      const readOnly = provider === 'claude_code' && attachments.some((attachment) => attachment.kind === 'image')
      const input: ChatTurnInput = {
        world,
        profile: settings.profile,
        feed,
        needsYou,
        history: turn.history,
        message: turn.message,
        attachments,
        imagesReadable: readOnly,
      }
      const prompt = buildSupervisorChatPrompt(input)
      const model = turn.model ?? defaultModel
      const outcome = readOnly
        ? await readOnlyCall(decider, { model, prompt, messageId: turn.id, repoPath: workspace.repoPath })
        : await decider({ model, prompt, maxBudgetUsd: SUPERVISOR_PER_CALL_CAP_USD })

      // A call that came back with no cost was still MADE: `unmeasured` is the intake's honesty
      // rule, and on a Cursor turn it is the only honest thing the panel can show (erratum E2).
      const unmeasured = outcome.costUsd === null
      if (outcome.kind !== 'answer') {
        const reason =
          outcome.kind === 'failed' ? outcome.reason : `isolation breach: ${outcome.tools.join(', ')}`
        process.stderr.write(`[chat] ${turn.id}: the model did not answer — ${reason}\n`)
        await settle(turn.id, { kind: 'failed', reason, costUsd: outcome.costUsd, unmeasured })
        return
      }

      const parsed = parseSupervisorReply(outcome.text, world)
      if (parsed === null) {
        await settle(turn.id, {
          kind: 'failed',
          reason: 'the reply could not be read',
          costUsd: outcome.costUsd,
          unmeasured,
        })
        return
      }

      // `renderedChatSources(input)` and nothing else: a citation may only be checked against what
      // THIS prompt put in front of the model -- the same feed window, the same attachment slices.
      // The verdict is kept BOTH ways (fix round 1, M2): `isSourced` onto the row's own `sourced`
      // column, which is the chip R2 asks the panel for, and a sentence in the reply when
      // something was cited and did not check out -- a person reading an answer deserves to know
      // the Supervisor quoted something that was not there, and a missing chip does not say it.
      const check = verifySources(parsed.sources, null, world, renderedChatSources(input))
      const { recorded: actions, notes: actionNotes } = await recordReplyActions(turn, parsed.actions, world)
      const notes = [
        ...parsed.dropped,
        ...actionNotes,
        ...(check.rejected.length === 0
          ? []
          : [`${plural(check.rejected.length, 'citation')} in this answer could not be checked against the record`]),
      ]
      const text = [
        parsed.text,
        ...(notes.length === 0 ? [] : ['', ...notes.map((note) => `(${note})`)]),
      ].join('\n')
      await settle(turn.id, {
        kind: 'answered',
        // A reply whose text is empty but whose actions stand is still a reply; a reply that is
        // empty AND asked for nothing gets one honest sentence rather than a blank bubble.
        text: text.trim() === '' && actions.length === 0 ? '(the Supervisor had nothing to say)' : text,
        actions,
        sourced: isSourced(check),
        costUsd: outcome.costUsd,
        unmeasured,
      })
    } catch (error) {
      await settle(turn.id, {
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        // A throw before the call returned is a call whose cost nobody measured. `unmeasured`
        // rather than zero, for the intake's reason: silence about money is not the same as none.
        costUsd: null,
        unmeasured: true,
      }).catch(() => undefined)
    }
  })()
  calls.start(turn.id, settled)
}

/** The one place a turn is written down, so every arm above reports its own refusal the same way. */
async function settle(messageId: string, outcome: Parameters<typeof recordSupervisorReply>[1]): Promise<void> {
  const recorded = await recordSupervisorReply(messageId, outcome)
  if (!recorded.ok) process.stderr.write(`[chat] ${messageId}: ${refusalText(recorded.error)}\n`)
}

/**
 * One global pass over every Supervisor turn waiting for a reply (F R2).
 *
 * `tickIntakes`' shape exactly: claim under `SKIP LOCKED`, start at most `maxConcurrentModelCalls`
 * detached calls, record when each settles, drain at shutdown. A turn never blocks the pass.
 *
 * UNLIKE the intake tick it always has a decider to try, because the registry is total -- so
 * there is no `skippedNoDecider` here. A workspace whose stored provider this registry does not
 * hold fails THAT TURN with {@link NO_DECIDER_REASON} rather than stranding it for five minutes
 * under a claim nothing will answer.
 *
 * `by` is this process's own name (`<pid>@<host>`), written onto the claim so an operator looking
 * at a stuck row can tell which daemon holds it.
 */
export async function tickSupervisorChat(input: {
  readonly now: Date
  readonly by: string
  readonly deciders: DeciderRegistry
  /** The model a workspace that pinned none is answered with -- `SLAVEOFAI_SUPERVISOR_MODEL` or
   *  `SUPERVISOR_DEFAULT_MODEL`, resolved by the daemon, never read from the environment here. */
  readonly defaultModel: string
  readonly maxConcurrentModelCalls?: number
}): Promise<TickSupervisorChatReport> {
  const due = await prisma.supervisorMessage.count({ where: { status: 'answering' } })
  const room = calls.room(input.maxConcurrentModelCalls ?? DEFAULT_MAX_MODEL_CALLS)
  if (room <= 0) return { due, startedModelCalls: 0, skippedInFlight: due }

  const claimed = await claimSupervisorTurns({ by: input.by, limit: room, now: input.now })
  let started = 0
  for (const turn of claimed) {
    // A row this process is already carrying: the claim can return one after a TTL reclaim races
    // its own in-flight call, and paying twice for one message is the thing the set exists to stop.
    if (calls.has(turn.id)) continue
    startChatTurn(turn, input.deciders, input.defaultModel, input.now)
    started += 1
  }
  return { due, startedModelCalls: started, skippedInFlight: Math.max(0, due - started) }
}
