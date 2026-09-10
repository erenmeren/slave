import { prisma } from '@slave-of-ai/db/client'
import { listDecisions } from '@slave-of-ai/control'
import { SITUATION_LABEL, needsYou, type TaskStatus } from '@slave-of-ai/domain'
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
 * DE-DUPLICATED PER TASK, which is the other half of E20: a blocked task with a pending decision
 * about it is ONE thing waiting on a person, not two. The decision wins, because the decision is
 * the row that carries an answer a person can give in place (approve / reject); the task-shaped
 * entry for it is dropped, and the domain is told `decisionPending` so its own verdict agrees.
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
}

export async function buildNeedsYou(
  workspaceId: string,
  now: Date = new Date(),
): Promise<readonly NeedsYouItem[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, autoMerge: true },
  })
  if (workspace === null) return []

  // One read for both task kinds: `blocked` and `done` are the only two statuses any of the three
  // task-shaped clauses can be in, so a single query answers all of them.
  const tasks = await prisma.task.findMany({
    where: { workspaceId, status: { in: ['blocked', 'done'] } },
    select: { id: true, title: true, status: true, integratedAt: true, lastRejectionReason: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const [decisions, view] = await Promise.all([
    listDecisions(workspaceId, { pending: true }),
    buildSupervisorView(workspaceId, now),
  ])

  // A decision's `subjectId` is a task id only for the task-shaped situations; for every other
  // kind it is a role name, a message id or the workspace's own id, none of which can collide with
  // a task id. So membership in this set IS "there is a pending decision about this task".
  const decidedSubjects = new Set(decisions.map((decision) => decision.subjectId))

  const items: NeedsYouItem[] = []

  for (const task of tasks) {
    const decisionPending = decidedSubjects.has(task.id)
    // The domain decides, not this file: `needsYou` is where the four rules live, and asking it
    // per task is what keeps the queue and the project card's count saying the same thing.
    if (
      !needsYou({
        status: task.status as TaskStatus,
        integrated: task.integratedAt !== null,
        autoMerge: workspace.autoMerge,
        decisionPending,
      })
    ) {
      continue
    }
    // E20's de-duplication: the decision row below is this task's one entry.
    if (decisionPending) continue
    const blocked = task.status === 'blocked'
    items.push({
      kind: blocked ? 'blocked_task' : 'integrate',
      id: task.id,
      title: blocked
        ? `${task.title} — ${task.lastRejectionReason ?? 'blocked'}`
        : `${task.title} — ready to integrate`,
      href: `/w/${workspaceId}/tasks?task=${task.id}`,
      since: task.createdAt.toISOString(),
      taskId: task.id,
      decisionId: null,
      messageId: null,
    })
  }

  for (const decision of decisions) {
    items.push({
      kind: 'decision',
      id: decision.id,
      // The label, never the member -- `docs/ia.md` rule 3, and the same table `ProposalRow`
      // reads. The raw kind reaches the page on the decision itself.
      title: `${SITUATION_LABEL[decision.situationKind]}: ${decision.situation.summary}`,
      href: `/w/${workspaceId}#decision-${decision.id}`,
      since: decision.createdAt,
      taskId: null,
      decisionId: decision.id,
      messageId: null,
    })
  }

  if (view !== null) {
    for (const question of view.questions) {
      // `holders === 0` is M39's unanswerable shape: the role the question went to has no live
      // holder, so nothing but a person will ever answer it. A question a slave CAN answer is
      // the fleet waiting on itself and is not on this list.
      if (question.holders !== 0) continue
      items.push({
        kind: 'question',
        id: question.messageId,
        title: `${question.askerName} asked: ${question.body}`,
        href: `/w/${workspaceId}#question-${question.messageId}`,
        since: question.since,
        taskId: null,
        decisionId: null,
        messageId: question.messageId,
      })
    }
  }

  // Oldest first: the thing that has waited longest is the thing to do.
  return items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
}
