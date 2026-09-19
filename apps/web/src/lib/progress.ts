import type { TaskStatus } from '@slave-of-ai/domain'

/**
 * How far along a task's own bar reads, by status (M61 R8) -- a PRESENTATION table, not the
 * pipeline's own truth. `Record<TaskStatus, ...>` and total, deliberately: a fourteenth status
 * added to `packages/domain/src/task/state.ts` fails the BUILD here rather than silently drawing
 * no bar for it. `null` means "draw no bar at all" -- the three parks (`waiting`, `blocked`,
 * `cancelled`) and the two ends nobody watches progress through (`failed`; `done` gets its own
 * `100`, not `null`, because a finished task's bar should read full, not vanish).
 *
 * `rework` reads `35`, the same as `running`: a reworked task is being worked on again, not
 * starting over from nothing, and giving it its own lower number would make the bar move
 * backwards on screen the moment a review sends it back -- the one motion a progress bar must
 * never make.
 */
export const PROGRESS_FOR_TASK_STATUS: Record<TaskStatus, number | null> = {
  backlog: 0,
  ready: 0,
  assigned: 10,
  running: 35,
  verifying: 60,
  reviewing: 80,
  merging: 90,
  rework: 35,
  waiting: null,
  blocked: null,
  done: 100,
  failed: null,
  cancelled: null,
}

/**
 * The bar's actual number: the table's value, except while a run is live -- then it moves INSIDE
 * the running band (35→60) with the run's own step progress, so a long run's bar creeps rather
 * than sitting still at 35 for however many minutes it takes (plan erratum E2). `runPct` is
 * clamped to `[0, 100]` so a caller's stray out-of-range figure cannot push the bar past the next
 * status's own number.
 */
export function progressOf(status: TaskStatus | null, runPct: number | null): number | null {
  if (status === null) return null
  const base = PROGRESS_FOR_TASK_STATUS[status]
  if (status !== 'running' || runPct === null || base === null) return base
  return Math.round(base + Math.max(0, Math.min(100, runPct)) * 0.25)
}
