import { listDecisions, loadSupervisorWorld, supervisorSettings, type DecisionView } from '@slave-of-ai/control'
import { summarise, type SupervisorReport } from '@slave-of-ai/domain'

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
  readonly settings: { readonly enabled: boolean; readonly profile: string | null }
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

  return { report: summarise(loaded.world), pending, recent, settings: loaded.settings }
}
