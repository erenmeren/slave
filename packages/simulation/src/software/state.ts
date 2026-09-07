import { z } from 'zod'

/** M31b design §3.1. Everything here is integer days; the sector carries no money and no
 *  randomness (design §1 principle 3), so two runs of one policy are byte-identical. */
export const expertiseSchema = z.enum(['backend', 'frontend', 'devops', 'general'])
export const areaSchema = z.enum(['backend', 'frontend', 'devops'])
export type Expertise = z.infer<typeof expertiseSchema>
export type Area = z.infer<typeof areaSchema>

export const engineerSchema = z.object({
  id: z.string(),
  expertise: expertiseSchema,
  busyUntilDay: z.number().int().nullable(),
  taskId: z.string().nullable(),
  absentUntilDay: z.number().int().nullable(),
})

export const taskSchema = z.object({
  id: z.string(),
  area: areaSchema,
  sizeDays: z.number().int().min(1).max(5),
  origin: z.enum(['request', 'incident', 'defect']),
  priority: z.enum(['normal', 'incident']),
  requestedDay: z.number().int(),
  dueDay: z.number().int(),
  queuedDay: z.number().int().nullable(),
  assignedTo: z.string().nullable(),
  startedDay: z.number().int().nullable(),
  finishedDay: z.number().int().nullable(),
  doneDay: z.number().int().nullable(),
  status: z.enum(['requested', 'queued', 'in_progress', 'in_review', 'done']),
  reviewed: z.boolean(),
  rework: z.number().int().nonnegative(),
  sourceTaskId: z.string().nullable(),
})

export const softwareStateSchema = z.object({
  engineers: z.array(engineerSchema),
  tasks: z.array(taskSchema),
  reviewCapacityPerDay: z.number().int().nonnegative(),
  reviewedToday: z.number().int().nonnegative(),
  // Task-2 erratum on design §3.1: the policy's third knob lives in the state beside the other
  // two. `applyEvent` is pure over `(state, event, day)` -- it never sees the definition -- and
  // §3.3's `task_finished` has to know whether the policy reviews this task, so the flag has to
  // be reachable from the state, exactly as `reviewCapacityPerDay` and `matchWaitDays` already are.
  reviewEverything: z.boolean(),
  matchWaitDays: z.number().int().nonnegative(),
  nextTaskSeq: z.number().int().positive(),
  idleEngineerDays: z.number().int().nonnegative(),
})

export type Engineer = z.infer<typeof engineerSchema>
export type Task = z.infer<typeof taskSchema>
export type SoftwareState = z.infer<typeof softwareStateSchema>

/** `absentUntilDay` is INCLUSIVE — the last day away — which is what design §3.3's two verbatim
 *  rules together say: `absence` sets it to `day + days`, and the day close clears every engineer
 *  whose `absentUntilDay <= day`. So the field is non-null exactly on the days the engineer is
 *  away, and "absent today" needs no day argument: `SectorModel.validate` is handed only
 *  `(state, role, action)`, so a predicate that needed the day could not be asked there at all. */
export function isAbsent(engineer: Engineer): boolean {
  return engineer.absentUntilDay !== null
}

export function isFree(engineer: Engineer): boolean {
  return engineer.busyUntilDay === null
}

/** Task ids are `t-<seq>`, so "id order" is creation order — which plain string comparison gets
 *  wrong the moment there are ten of them (`t-10` < `t-2`). Compare the sequence numerically. */
export function compareTaskIds(a: string, b: string): number {
  const seq = (id: string): number => Number(id.replace(/^t-/, ''))
  const [x, y] = [seq(a), seq(b)]
  return Number.isNaN(x) || Number.isNaN(y) ? a.localeCompare(b) : x - y
}

/** The lead's queue order (§3.2 / the task-2 brief): incidents first, then the older `queuedDay`,
 *  then id order. */
export function compareQueue(a: Task, b: Task): number {
  const rank = (t: Task): number => (t.priority === 'incident' ? 0 : 1)
  return rank(a) - rank(b) || (a.queuedDay ?? 0) - (b.queuedDay ?? 0) || compareTaskIds(a.id, b.id)
}

export function initialSoftwareState(input: {
  readonly engineers: readonly { readonly id: string; readonly expertise: Expertise }[]
  readonly reviewCapacityPerDay: number
  readonly reviewEverything: boolean
  readonly matchWaitDays: number
}): SoftwareState {
  return {
    engineers: input.engineers.map((e) => ({ id: e.id, expertise: e.expertise, busyUntilDay: null, taskId: null, absentUntilDay: null })),
    tasks: [],
    reviewCapacityPerDay: input.reviewCapacityPerDay,
    reviewedToday: 0,
    reviewEverything: input.reviewEverything,
    matchWaitDays: input.matchWaitDays,
    nextTaskSeq: 1,
    idleEngineerDays: 0,
  }
}
