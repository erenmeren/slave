import type { TaskId } from '../ids.js'

export interface MergeCandidate {
  readonly taskId: TaskId
  readonly branch: string
  readonly enqueuedAt: number
  /** True while the branch is behind main and has not been rebased yet. */
  readonly blockedUntilRebase: boolean
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

  const eligible = [...queue]
    .filter((c) => !c.blockedUntilRebase)
    .sort((a, b) => (a.enqueuedAt - b.enqueuedAt) || a.taskId.localeCompare(b.taskId))

  return eligible[0] ?? null
}
