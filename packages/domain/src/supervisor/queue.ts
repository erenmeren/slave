import { cardKey, isQuestionSituation } from './cards.js'
import type { SituationKind } from './situations.js'

/**
 * Human cards H4 (plan B D8): the needs-you queue, one per goal version.
 *
 * Spec H4: "Cards are listed per goal version. Within a version, those blocking it (a paused run,
 * `needs_human`) come first. Cards on one subject -- the same question, task, package or file --
 * merge into one card." The pure half lives here so every surface (the strip, the Overview, Home)
 * orders and merges by one rule; the web's `buildNeedsYou` reads the rows and calls it.
 */

/** Cards that block their goal version on their own -- beyond a question whose asker is parked. */
export const BLOCKING_SITUATION_KINDS: readonly SituationKind[] = ['goal_needs_human', 'task_blocked_human']

/**
 * The situations whose subject is a task (`observe`'s `subjectId: task.id`): a card about a task
 * merges with that task's other items -- its blocked row, its integrate row, its other cards.
 * `package_seat_lost` and `foreign_file` are the package and file cases of spec H4: both are raised
 * on the package's task, so "the same package or file" is the same task here.
 */
const TASK_KINDS: ReadonlySet<SituationKind> = new Set<SituationKind>([
  'review_cap_blocked',
  'task_failed',
  'task_blocked_human',
  'stale_task',
  'done_not_integrated_stale',
  'package_seat_lost',
  'foreign_file',
])

/** True for the situations whose `subjectId` is a task id. */
export function isTaskSituation(kind: SituationKind): boolean {
  return TASK_KINDS.has(kind)
}

/** `<ws>:v<n>...` subjects (the verification and goal cards) name their version; nothing else does. */
export function versionOfSubject(subjectId: string): number | null {
  const match = /:v(\d+)(?::|$)/u.exec(subjectId)
  return match === null ? null : Number(match[1])
}

/**
 * Plan B D8: the subject one queue row stands for -- a question, a task, or the card's own key.
 * The fallback is `cardKey` itself (pre-flight F59), so a card held under one key is listed under
 * the same key.
 */
export function groupKeyFor(input: {
  readonly kind: 'decision' | 'question' | 'blocked_task' | 'integrate'
  readonly situationKind: SituationKind | null
  readonly subjectId: string
  readonly taskId: string | null
}): string {
  if (input.kind === 'question') return `question:${input.subjectId}`
  if (input.kind === 'blocked_task' || input.kind === 'integrate') return `task:${input.taskId ?? input.subjectId}`
  if (input.situationKind === null) return `item:${input.subjectId}`
  if (isQuestionSituation(input.situationKind)) return cardKey(input.situationKind, input.subjectId)
  if (TASK_KINDS.has(input.situationKind)) return `task:${input.taskId ?? input.subjectId}`
  return cardKey(input.situationKind, input.subjectId)
}

/** One item of the queue, as far as ordering and merging need it. */
export interface QueueCard {
  readonly id: string
  readonly groupKey: string
  readonly goalVersion: number | null
  readonly blocking: boolean
  /** ISO: when it started waiting. */
  readonly since: string
  /** A pending decision (a card). Pre-flight F27, refined in Task 9 fix round 1: a group's head is
   *  its oldest BLOCKING decision, else its oldest decision -- the card is what carries the action --
   *  else its oldest item. */
  readonly decision: boolean
}

/** One row of the queue: every item on one subject within one goal version. */
export interface QueueGroup {
  readonly key: string
  readonly goalVersion: number | null
  /** Any member blocks the version. */
  readonly blocking: boolean
  /** ISO: the oldest member's -- how long this subject has waited, whoever heads the row. */
  readonly since: string
  /** The merged items: the head first (the oldest blocking decision, else the oldest decision, else
   *  the oldest item), then the rest oldest first. Never empty. */
  readonly ids: readonly string[]
}

/**
 * Spec H4 (plan B D8): one queue per goal version -- the newest version first, project-level items
 * (no version) last; within a version the groups that block it first, then the oldest.
 */
export function buildQueue(cards: readonly QueueCard[]): readonly QueueGroup[] {
  const byKey = new Map<string, QueueCard[]>()
  for (const card of [...cards].sort((a, b) => Date.parse(a.since) - Date.parse(b.since))) {
    const key = `${card.goalVersion ?? 'project'}|${card.groupKey}`
    const members = byKey.get(key)
    if (members === undefined) byKey.set(key, [card])
    else members.push(card)
  }
  const groups: QueueGroup[] = []
  for (const members of byKey.values()) {
    const oldest = members[0]
    if (oldest === undefined) continue
    // Fix round 1 ruling: the head is the card that blocks, else any card, else the oldest item --
    // a row marked blocking must offer the blocking card's decisions, not an older card's.
    const head = members.find((member) => member.decision && member.blocking) ?? members.find((member) => member.decision) ?? oldest
    groups.push({
      key: oldest.groupKey,
      goalVersion: oldest.goalVersion,
      blocking: members.some((member) => member.blocking),
      since: oldest.since,
      ids: [head.id, ...members.filter((member) => member !== head).map((member) => member.id)],
    })
  }
  const versionRank = (version: number | null): number => (version === null ? Number.NEGATIVE_INFINITY : version)
  return groups.sort(
    (a, b) =>
      versionRank(b.goalVersion) - versionRank(a.goalVersion) ||
      Number(b.blocking) - Number(a.blocking) ||
      Date.parse(a.since) - Date.parse(b.since),
  )
}
