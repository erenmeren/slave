import { prisma } from '@slave-of-ai/db/client'
import { listDecisions, type DecisionView } from '@slave-of-ai/control'
import {
  BLOCKING_SITUATION_KINDS,
  SITUATION_LABEL,
  buildQueue,
  groupKeyFor,
  isQuestionSituation,
  isTaskSituation,
  needsYou,
  versionOfSubject,
  type TaskStatus,
} from '@slave-of-ai/domain'
import { buildSupervisorView } from './supervisor'

/**
 * One thing a person has to do, and where to do it (M45 R1).
 *
 * FOUR SOURCES, not one predicate. `needsYou(facts)` in the domain is per-TASK, and three of the
 * four kinds below are tasks -- but a pending `SupervisorDecision` has no task column at all: its
 * `subjectId` is a task id, a message id, a role name or the workspace's own id depending on the
 * situation, and plenty of pending decisions are about no task (a `ready_unstaffed` is about a
 * role). So decisions are counted as ROWS, exactly the way `docs/ia.md` records it for the project
 * card's own count (M45 plan erratum E20).
 *
 * Human cards H4: per goal version, blocking first, one row per subject. Spec H4: "Cards are
 * listed per goal version. Within a version, those blocking it (a paused run, `needs_human`) come
 * first. Cards on one subject -- the same question, task, package or file -- merge into one card."
 * The order and the merge are the domain's (`buildQueue`, `groupKeyFor`); this file reads the rows.
 * A blocked task with a pending decision about it is still ONE row (E20), now because it MERGES
 * into the decision's row (`task:<id>`) rather than being dropped: the decision heads the row, and
 * the task rides on it in `merged`, so nothing a person has to do is hidden behind the merge. A
 * question with an open card is listed once, as the card.
 *
 * `href` always points at a surface that can actually resolve the item. `integrate` links to the
 * board rather than offering a button, because `confirmIntegration` has no web route -- it is a
 * control verb the CLI drives, and inventing a route for it is a decision this milestone did not
 * make (plan erratum E11).
 */
export interface NeedsYouItem {
  readonly kind: 'blocked_task' | 'decision' | 'question' | 'integrate'
  /** Stable within a snapshot: the row's own id, so React keys and the gate can both name it. */
  readonly id: string
  readonly title: string
  readonly href: string
  /** ISO. When this started waiting -- the task's creation, the decision's, the question's. */
  readonly since: string
  readonly taskId: string | null
  readonly decisionId: string | null
  readonly messageId: string | null
  /** Human cards H4, plan B D8: the goal version this item belongs to -- the question's, the task's
   *  (its package's version, else its own stamp), or the one a `<ws>:v<n>` subject names. Null for a
   *  project-level item, which is listed after every version. */
  readonly goalVersion: number | null
  /** Human cards H4, plan B D8: this row blocks its version -- it holds a question whose asker is
   *  parked, a `goal_needs_human`, a `task_blocked_human` or a blocked task. A merged row blocks
   *  when any of its items does. */
  readonly blocking: boolean
  /** Human cards H4, plan B D8: the subject the row stands for (`groupKeyFor`): `question:<id>`,
   *  `task:<id>`, or the card's own key. */
  readonly groupKey: string
  /** Human cards H4, plan B D8: the ids of the items merged into this row, besides its own. */
  readonly mergedIds: readonly string[]
  /** The merged items themselves, oldest first (each with nothing merged into it): merging never
   *  hides something a person has to do, so the row leads to every one of them, and a page that
   *  acts on each item -- the activity timeline -- still lists them all. */
  readonly merged: readonly NeedsYouItem[]
  /** Human cards H4, plan B D8: the row can be settled in one click -- a machine card's approve,
   *  or `send_answer` on a question card that offers it (pre-flight F56). False on every question
   *  card that does not offer `send_answer` (a draftless answer card included): its row links to
   *  the card's decisions instead. False on every item that is not a decision. */
  readonly oneClick: boolean
  /** The row is a question card (Plan A D13): its one click is `send_answer` through the decide
   *  route, and it has no Reject -- "dismiss and close" is one of the card's decisions. */
  readonly questionCard: boolean
  /** Task 9 fix round 1: the words a question card's one click would send -- the draft as a person
   *  edited it, else as drafted (what `send_answer` sends) -- cut to {@link DRAFT_PREVIEW_MAX_CHARS}.
   *  A person must not send words they cannot see. Null on every row without that one click. */
  readonly draftPreview: string | null
}

/** How much of a draft a needs-you row shows beside its one click: enough to recognise the answer;
 *  the whole of it is on the card, one link away. */
export const DRAFT_PREVIEW_MAX_CHARS = 280

/** The draft `send_answer` would send, cut to the preview's bound on a whole character. */
function draftPreviewOf(draft: DecisionView['draft']): string | null {
  const body = draft?.editedBody ?? draft?.body ?? null
  if (body === null) return null
  const chars = [...body]
  return chars.length <= DRAFT_PREVIEW_MAX_CHARS ? body : `${chars.slice(0, DRAFT_PREVIEW_MAX_CHARS - 1).join('')}…`
}

/** One item before the queue is built: everything but what the merge decides. */
type QueueItem = Omit<NeedsYouItem, 'mergedIds' | 'merged'>

/** The pending decisions `buildOverviewSnapshot` has already listed, handed down rather than
 *  listed again (fix round 1, review Important 8). Optional, with a fallback read, so a direct
 *  caller still gets a correct queue from a workspace id alone. */
export interface NeedsYouReads {
  readonly decisions?: readonly DecisionView[]
}

export async function buildNeedsYou(
  workspaceId: string,
  now: Date = new Date(),
  shared: NeedsYouReads = {},
): Promise<readonly NeedsYouItem[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, autoMerge: true },
  })
  if (workspace === null) return []

  // One read for both task kinds: `blocked` and `done` are the only two statuses any of the three
  // task-shaped clauses can be in, so a single query answers all of them. The version is the
  // package's, else the task's own stamp -- the same reading a question card's version is.
  const tasks = await prisma.task.findMany({
    where: { workspaceId, status: { in: ['blocked', 'done'] } },
    select: {
      id: true,
      title: true,
      status: true,
      integratedAt: true,
      lastRejectionReason: true,
      createdAt: true,
      goalVersion: true,
      workPackage: { select: { goalVersion: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const [decisions, view] = await Promise.all([
    shared.decisions ?? listDecisions(workspaceId, { pending: true }),
    // The one read this file cannot avoid making: `holdersOf` -- the rule that says a question has
    // no live holder -- is private to `packages/control/src/supervisorWorld.ts`, so the only way to
    // ask "which questions can nobody but a person answer" is to walk the Supervisor's world.
    // `buildSupervisorView` lists decisions twice more of its own accord (`pending` and `recent`,
    // for the panel it was written for); that is amplification this milestone did not introduce
    // and does not fix, and narrowing it means a question-shaped read in `control`.
    buildSupervisorView(workspaceId, now),
  ])

  // The task a decision is about: its facts' `taskId` (a run's card names its task there), else its
  // subject for the task situations. Only for the version and the merge -- never a task the
  // decision row claims to BE.
  const taskOfDecision = (decision: DecisionView): string | null => {
    const fact = decision.situation.facts['taskId']
    if (typeof fact === 'string') return fact
    return isTaskSituation(decision.situationKind) ? decision.subjectId : null
  }

  // The versions of the decisions' tasks the read above did not already hold: one more query, and
  // none at all when every decision is about a blocked or done task, or about no task.
  const versionOfTask = new Map(tasks.map((task) => [task.id, task.workPackage?.goalVersion ?? task.goalVersion ?? null] as const))
  const unread = [...new Set(decisions.flatMap((decision) => {
    const taskId = taskOfDecision(decision)
    return taskId === null || versionOfTask.has(taskId) ? [] : [taskId]
  }))]
  if (unread.length > 0) {
    const rows = await prisma.task.findMany({
      where: { workspaceId, id: { in: unread } },
      select: { id: true, goalVersion: true, workPackage: { select: { goalVersion: true } } },
    })
    for (const row of rows) versionOfTask.set(row.id, row.workPackage?.goalVersion ?? row.goalVersion ?? null)
  }

  const items: QueueItem[] = []

  for (const task of tasks) {
    // The domain decides which tasks need a person, not this file: `needsYou` is where the four
    // rules live. NOTE that the project card's own needs-you count (`server/org.ts`) does NOT
    // agree with this queue today -- it counts decisions and tasks by its own reading -- and
    // reconciling the two on this function is its own piece of work, not this milestone's.
    if (
      !needsYou({
        status: task.status as TaskStatus,
        integrated: task.integratedAt !== null,
        autoMerge: workspace.autoMerge,
      })
    ) {
      continue
    }
    const blocked = task.status === 'blocked'
    const kind = blocked ? 'blocked_task' : 'integrate'
    items.push({
      kind,
      id: task.id,
      title: blocked
        ? `${task.title} — ${task.lastRejectionReason ?? 'blocked'}`
        : `${task.title} — ready to integrate`,
      href: `/w/${workspaceId}/tasks?task=${task.id}`,
      since: task.createdAt.toISOString(),
      taskId: task.id,
      decisionId: null,
      messageId: null,
      goalVersion: versionOfTask.get(task.id) ?? null,
      // Plan B D8: a blocked task blocks its version; work waiting to be integrated does not.
      blocking: blocked,
      // E20 / spec H4: a blocked task with a pending decision about it merges into that decision's
      // row through this key, rather than being dropped.
      groupKey: groupKeyFor({ kind, situationKind: null, subjectId: task.id, taskId: task.id }),
      oneClick: false,
      questionCard: false,
      draftPreview: null,
    })
  }

  for (const decision of decisions) {
    const taskId = taskOfDecision(decision)
    const card = decision.card ?? null
    items.push({
      kind: 'decision',
      id: decision.id,
      // The label, never the member -- `docs/ia.md` rule 3, and the same table `ProposalRow`
      // reads. The raw kind reaches the page on the decision itself.
      title: `${SITUATION_LABEL[decision.situationKind]}: ${decision.situation.summary}`,
      // Ruling F17 (human cards plan B): the `#decision-<id>` anchor exists only on the activity
      // page's timeline, which is where a question card's decisions render; `/w/<ws>` is the team.
      href: `/w/${workspaceId}/activity#decision-${decision.id}`,
      since: decision.createdAt,
      taskId: null,
      decisionId: decision.id,
      messageId: null,
      goalVersion: card?.goalVersion ?? (taskId === null ? null : (versionOfTask.get(taskId) ?? null)) ?? versionOfSubject(decision.subjectId),
      blocking: card?.askerWaiting === true || BLOCKING_SITUATION_KINDS.includes(decision.situationKind),
      groupKey: groupKeyFor({ kind: 'decision', situationKind: decision.situationKind, subjectId: decision.subjectId, taskId }),
      // Pre-flight F56: a question card's one click is `send_answer`, so it is offered only where
      // the card offers it -- never on a draftless answer card, which would approve into
      // `draft_missing`, and never on an escalation or a re-address card, whose decisions are the
      // card's own. A machine card keeps its approve.
      oneClick: card === null || card.offers.includes('send_answer'),
      questionCard: card !== null,
      draftPreview: card !== null && card.offers.includes('send_answer') ? draftPreviewOf(decision.draft) : null,
    })
  }

  // Spec H4: "a question with an open card is listed once, as the card" -- the card is its row.
  const carded = new Set(decisions.filter((decision) => isQuestionSituation(decision.situationKind)).map((decision) => decision.subjectId))

  if (view !== null) {
    for (const question of view.questions) {
      // `holders === 0` is M39's unanswerable shape: the role the question went to has no live
      // holder, so nothing but a person will ever answer it. A question a slave CAN answer is
      // the fleet waiting on itself and is not on this list.
      if (question.holders !== 0) continue
      if (carded.has(question.messageId)) continue
      items.push({
        kind: 'question',
        id: question.messageId,
        title: `${question.askerName} asked: ${question.body}`,
        // The same page, for the same reason: the answer box is the timeline's (ruling F17).
        href: `/w/${workspaceId}/activity#question-${question.messageId}`,
        since: question.since,
        taskId: null,
        decisionId: null,
        messageId: question.messageId,
        goalVersion: question.goalVersion,
        // Pre-flight F27: a bare question blocks its version when its asker is parked on it.
        blocking: question.askerWaiting,
        groupKey: groupKeyFor({ kind: 'question', situationKind: null, subjectId: question.messageId, taskId: null }),
        oneClick: false,
        questionCard: false,
        draftPreview: null,
      })
    }
  }

  // Spec H4 (plan B D8): newest version first, project-level items last; within a version what
  // blocks it first, then the oldest; one row per subject, headed by its card.
  const itemKey = (item: QueueItem): string => `${item.kind}:${item.id}`
  const byKey = new Map(items.map((item) => [itemKey(item), item] as const))
  const groups = buildQueue(
    items.map((item) => ({
      id: itemKey(item),
      groupKey: item.groupKey,
      goalVersion: item.goalVersion,
      blocking: item.blocking,
      since: item.since,
      decision: item.kind === 'decision',
    })),
  )
  return groups.flatMap((group): NeedsYouItem[] => {
    const [head, ...rest] = group.ids.flatMap((id) => {
      const item = byKey.get(id)
      return item === undefined ? [] : [item]
    })
    if (head === undefined) return []
    const merged = rest.map((item): NeedsYouItem => ({ ...item, mergedIds: [], merged: [] }))
    return [{ ...head, blocking: group.blocking, mergedIds: merged.map((item) => item.id), merged }]
  })
}
