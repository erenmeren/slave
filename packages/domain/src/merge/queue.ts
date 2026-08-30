import type { TaskId } from '../ids.js'

export interface MergeCandidate {
  readonly taskId: TaskId
  readonly branch: string
  readonly enqueuedAt: number
  /** True while the branch is behind main and has not been rebased yet. */
  readonly blockedUntilRebase: boolean
}

/**
 * The merge queue's ORDER: FIFO by `enqueuedAt`, ties broken by task id so two candidates
 * enqueued at the same instant order deterministically rather than by array position.
 *
 * Lifted out of `nextMergeCandidate` verbatim (M14 Task 8) because Overview's "merge queue ·
 * serial" panel has to SHOW the queue the daemon is going to process, and a second sort written
 * in the web app is exactly how a panel and the daemon that feeds it drift apart. Generic over
 * the row rather than fixed to `MergeCandidate`: the panel has an id and a position and no
 * branch, and inventing a branch for it just to reuse this would be worse than the parameter.
 */
export function mergeQueueOrder<T extends { readonly taskId: string; readonly enqueuedAt: number }>(
  queue: readonly T[],
): readonly T[] {
  return [...queue].sort((a, b) => (a.enqueuedAt - b.enqueuedAt) || a.taskId.localeCompare(b.taskId))
}

/**
 * Merges are strictly serialized (spec §10): concurrent merges are exactly the case
 * where two independently green branches can break main together.
 */
export function nextMergeCandidate(
  queue: readonly MergeCandidate[],
  mergeInProgress: boolean,
): MergeCandidate | null {
  if (mergeInProgress) return null

  return mergeQueueOrder(queue.filter((c) => !c.blockedUntilRebase))[0] ?? null
}
