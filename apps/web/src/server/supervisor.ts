import { listDecisions, loadSupervisorWorld, supervisorSettings, type DecisionView } from '@slave-of-ai/control'
import { displayName, summarise, type SupervisorQuestion, type SupervisorSlave, type SupervisorReport } from '@slave-of-ai/domain'

/**
 * How many past decisions the panel carries. Twenty is what fits under the pending list without
 * turning the overview into a log -- the whole history is `supervisor-decisions` on the CLI, and
 * the timeline's `supervisor.*` cards are the searchable record. `listDecisions`' own default
 * (50) is the CLI's, and stays the CLI's.
 */
export const RECENT_DECISION_LIMIT = 20

/** Everything the Supervisor panel reads in one round: what the workspace looks like, what is
 *  waiting on a human, what was decided lately, and the two settings that govern all of it. */
export interface SupervisorView {
  readonly report: SupervisorReport
  /** Every `pending` decision, newest first -- the proposals with an Approve and a Reject. */
  readonly pending: readonly DecisionView[]
  /** The last {@link RECENT_DECISION_LIMIT} decisions of any status, newest first. Overlaps
   *  `pending` deliberately: a proposal is a decision, and hiding it from the history until
   *  somebody answers it would make the list read as though nothing had happened. */
  readonly recent: readonly DecisionView[]
  /** Every question still waiting on an answer (M39 §6) -- the panel's mailbox block, and what a
   *  drafted answer's proposal row shows the question of. Straight off the world the report was
   *  computed from, so the two cannot disagree about what is outstanding. */
  readonly questions: readonly SupervisorQuestionView[]
  readonly settings: { readonly enabled: boolean; readonly profile: string | null }
}

/** One pending question, flattened for a browser (M39 §6). The world's own `SupervisorQuestion`
 *  carries the whole thread, the asker's recorded run prompt and every holder id -- a model's
 *  input, not a panel's -- so this is the narrow read of it: what was asked, by whom, who it waits
 *  on, how many workers could take it, and since when. */
export interface SupervisorQuestionView {
  readonly messageId: string
  readonly body: string
  /** `displayName` (`@slave-of-ai/domain`), the ONE formatting of a worker's identity -- the same
   *  string the CLI's `messages` and the ask roster print. The bare id when the asker has left the
   *  roster, which is findable rather than invented. */
  readonly askerName: string
  /** Who owes the answer: the role it was addressed to, or the worker it was addressed to by name. */
  readonly waitingOn: string
  /** How many workers may answer it today (`SupervisorQuestion.holders`). Zero is the
   *  `unanswerable_question` shape -- nobody holds the role, and no re-address can fix it. */
  readonly holders: number
  /** When it was asked, ISO -- the world speaks epoch ms, and nothing but a string survives the
   *  route's `Response.json` unchanged. */
  readonly since: string
}

/**
 * The Supervisor panel's whole read (M38 §6), or `null` for a workspace that does not exist.
 *
 * `summarise(world)` rather than a control verb that returns a report (spec erratum E2): the
 * report is a pure function of the world, and whoever holds the world computes it -- this builder
 * for the web, `cli.ts` for the terminal. There is no second idea of what "done / stuck / next"
 * means to drift.
 *
 * `supervisorSettings` first, only to tell "no such project" from "a project with nothing in it":
 * `loadSupervisorWorld` opens a `RepeatableRead` transaction and throws on a missing workspace,
 * which is the right behaviour for the tick (a workspace that vanished mid-pass is a bug) and the
 * wrong one for a route, which owes the caller a 404. The settings this returns are the SNAPSHOT's
 * -- read inside the same transaction as the world they govern -- not this pre-check's, so the
 * toggle an operator sees and the profile the prompt would carry are one reading.
 */
export async function buildSupervisorView(workspaceId: string, now: Date = new Date()): Promise<SupervisorView | null> {
  if ((await supervisorSettings(workspaceId)) === null) return null

  const loaded = await loadSupervisorWorld(workspaceId, now)
  const [pending, recent] = await Promise.all([
    listDecisions(workspaceId, { pending: true }),
    listDecisions(workspaceId, { limit: RECENT_DECISION_LIMIT }),
  ])

  return {
    report: summarise(loaded.world),
    pending,
    recent,
    questions: loaded.world.questions.map((one) => toQuestionView(one, loaded.world.slaves)),
    settings: loaded.settings,
  }
}

/** One world question as the panel reads it. `roster` is the world's own slave list -- the same
 *  snapshot the question came from, so a name here can never belong to a worker who was not there
 *  when the question was loaded. */
function toQuestionView(question: SupervisorQuestion, roster: readonly SupervisorSlave[]): SupervisorQuestionView {
  const nameOf = (slaveId: string): string => {
    const slave = roster.find((one) => one.id === slaveId)
    return slave === undefined ? slaveId : displayName(slave)
  }
  return {
    messageId: question.messageId,
    body: question.body,
    askerName: nameOf(question.askerSlaveId),
    // Exactly one of the two columns identifies a recipient (`isValidRecipient`), and the role case
    // is worded the way the CLI's `messages` words it -- an operator reading both must not have to
    // learn two vocabularies for the same fact.
    waitingOn:
      question.recipientSlaveId !== null
        ? nameOf(question.recipientSlaveId)
        : `anyone with the ${question.recipientRole ?? 'unknown'} role`,
    holders: question.holders.length,
    since: new Date(question.createdAt).toISOString(),
  }
}
