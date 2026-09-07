import type { ActionEnvelope } from '../core/action.js'
import type { Applied, RoleDefinition, SectorModel } from '../core/sector.js'
import { acceptRequestParams, assignTaskParams, noteParams, reviewTaskParams, type SoftwareRejection } from './actions.js'
import { softwareEventSchema, softwareExternalEventSchema, type SoftwareEvent } from './events.js'
import { compareQueue, compareTaskIds, isAbsent, isFree, type Area, type Engineer, type SoftwareState, type Task } from './state.js'

type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: SoftwareRejection }
const ok: Verdict = { ok: true }
const no = (reason: SoftwareRejection): Verdict => ({ ok: false, reason })

/** The three constants the whole sector's determinism hangs on (design §3.2/§3.3): a mismatched
 *  engineer takes half again as long, an unreviewed task of three days or more (or any unreviewed
 *  mismatch) surfaces a defect three days later, and an incident is one day of work. */
export const MISMATCH_FACTOR = 1.5
export const DEFECT_DELAY_DAYS = 3
export const DEFECT_SIZE_THRESHOLD = 3
export const INCIDENT_SIZE_DAYS = 1

function durationFor(task: Task, engineer: Engineer): number {
  return engineer.expertise === task.area ? task.sizeDays : Math.ceil(task.sizeDays * MISMATCH_FACTOR)
}

function newTask(state: SoftwareState, fields: Omit<Task, 'id'>): { readonly task: Task; readonly state: SoftwareState } {
  const task: Task = { id: `t-${state.nextTaskSeq}`, ...fields }
  return { task, state: { ...state, nextTaskSeq: state.nextTaskSeq + 1, tasks: [...state.tasks, task] } }
}

/** An incident — injected or surfaced from a defect — skips product: it arrives already queued.
 *  Its due day is the earliest date a single day of work could land, which is the only honest one
 *  available: unlike a `request`, an incident carries no `dueInDays` from outside (task-2 erratum). */
function incidentTask(state: SoftwareState, input: { readonly area: Area; readonly origin: 'incident' | 'defect'; readonly sourceTaskId: string | null }, day: number): { readonly task: Task; readonly state: SoftwareState } {
  return newTask(state, {
    area: input.area, sizeDays: INCIDENT_SIZE_DAYS, origin: input.origin, priority: 'incident', requestedDay: day, dueDay: day + INCIDENT_SIZE_DAYS,
    queuedDay: day, assignedTo: null, startedDay: null, finishedDay: null, doneDay: null, status: 'queued', reviewed: false, rework: 0, sourceTaskId: input.sourceTaskId,
  })
}

function patchTask(state: SoftwareState, taskId: string, patch: Partial<Task>): SoftwareState {
  return { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) }
}

function patchEngineer(state: SoftwareState, engineerId: string, patch: Partial<Engineer>): SoftwareState {
  return { ...state, engineers: state.engineers.map((e) => (e.id === engineerId ? { ...e, ...patch } : e)) }
}

function validate(state: SoftwareState, _role: RoleDefinition, action: ActionEnvelope): Verdict {
  switch (action.type) {
    case 'note':
      return noteParams.safeParse(action.params).success ? ok : no({ kind: 'bad_params', detail: 'note needs { text }' })
    case 'accept_request': {
      const p = acceptRequestParams.safeParse(action.params)
      if (!p.success) return no({ kind: 'bad_params', detail: 'accept_request needs { taskId }' })
      const task = state.tasks.find((t) => t.id === p.data.taskId)
      if (task === undefined) return no({ kind: 'unknown_task', taskId: p.data.taskId })
      return task.status === 'requested' ? ok : no({ kind: 'wrong_status', status: task.status })
    }
    case 'assign_task': {
      const p = assignTaskParams.safeParse(action.params)
      if (!p.success) return no({ kind: 'bad_params', detail: 'assign_task needs { taskId, engineerId }' })
      const task = state.tasks.find((t) => t.id === p.data.taskId)
      if (task === undefined) return no({ kind: 'unknown_task', taskId: p.data.taskId })
      if (task.status !== 'queued') return no({ kind: 'wrong_status', status: task.status })
      const engineer = state.engineers.find((e) => e.id === p.data.engineerId)
      if (engineer === undefined) return no({ kind: 'unknown_engineer', engineerId: p.data.engineerId })
      if (!isFree(engineer)) return no({ kind: 'engineer_busy', engineerId: engineer.id })
      return isAbsent(engineer) ? no({ kind: 'engineer_absent', engineerId: engineer.id }) : ok
    }
    case 'review_task': {
      const p = reviewTaskParams.safeParse(action.params)
      if (!p.success) return no({ kind: 'bad_params', detail: 'review_task needs { taskId }' })
      const task = state.tasks.find((t) => t.id === p.data.taskId)
      if (task === undefined) return no({ kind: 'unknown_task', taskId: p.data.taskId })
      if (task.status !== 'in_review') return no({ kind: 'wrong_status', status: task.status })
      return state.reviewedToday < state.reviewCapacityPerDay ? ok : no({ kind: 'review_capacity_exhausted', reviewCapacityPerDay: state.reviewCapacityPerDay })
    }
    default:
      return no({ kind: 'unknown_action', type: action.type })
  }
}

function apply(state: SoftwareState, _role: RoleDefinition, action: ActionEnvelope, day: number): Applied<SoftwareState, SoftwareEvent> {
  switch (action.type) {
    case 'accept_request': {
      const { taskId } = acceptRequestParams.parse(action.params)
      return { state: patchTask(state, taskId, { status: 'queued', queuedDay: day }), schedule: [], record: { taskId, queuedDay: day } }
    }
    case 'assign_task': {
      const { taskId, engineerId } = assignTaskParams.parse(action.params)
      const task = state.tasks.find((t) => t.id === taskId)
      const engineer = state.engineers.find((e) => e.id === engineerId)
      if (task === undefined || engineer === undefined) return { state, schedule: [] }
      const duration = durationFor(task, engineer)
      const busyUntilDay = day + duration
      const withTask = patchTask(state, taskId, { status: 'in_progress', startedDay: day, assignedTo: engineerId })
      return {
        state: patchEngineer(withTask, engineerId, { busyUntilDay, taskId }),
        schedule: [{ time: busyUntilDay, priority: 'scheduled', event: { type: 'task_finished', taskId } }],
        record: { taskId, engineerId, duration, matched: engineer.expertise === task.area, finishesDay: busyUntilDay },
      }
    }
    case 'review_task': {
      const { taskId } = reviewTaskParams.parse(action.params)
      const reviewed = patchTask(state, taskId, { status: 'done', reviewed: true, doneDay: day })
      return { state: { ...reviewed, reviewedToday: state.reviewedToday + 1 }, schedule: [], record: { taskId, doneDay: day } }
    }
    default:
      return { state, schedule: [], record: { text: String(action.params['text'] ?? '') } }
  }
}

function applyEvent(state: SoftwareState, event: SoftwareEvent, day: number): Applied<SoftwareState, SoftwareEvent> & { readonly record: Readonly<Record<string, unknown>> } {
  switch (event.type) {
    case 'request': {
      const created = newTask(state, {
        area: event.area, sizeDays: event.sizeDays, origin: 'request', priority: 'normal', requestedDay: day, dueDay: day + event.dueInDays,
        queuedDay: null, assignedTo: null, startedDay: null, finishedDay: null, doneDay: null, status: 'requested', reviewed: false, rework: 0, sourceTaskId: null,
      })
      return { state: created.state, schedule: [], record: { taskId: created.task.id, dueDay: created.task.dueDay } }
    }
    case 'incident': {
      const created = incidentTask(state, { area: event.area, origin: 'incident', sourceTaskId: null }, day)
      return { state: created.state, schedule: [], record: { taskId: created.task.id, dueDay: created.task.dueDay } }
    }
    case 'absence': {
      const engineer = state.engineers.find((e) => e.id === event.engineerId)
      if (engineer === undefined) return { state, schedule: [], record: { ignored: 'unknown_engineer', engineerId: event.engineerId } }
      const absentUntilDay = day + event.days
      // Mid-task, the work does not change hands: the engineer keeps it, everything slips by the
      // absence, and the already-queued `task_finished` is re-scheduled at the new day (the stale
      // one fires first and is ignored below, the way trade ignores an early delivery).
      const busyUntilDay = engineer.busyUntilDay === null ? null : engineer.busyUntilDay + event.days
      const shiftedTaskId = busyUntilDay !== null ? engineer.taskId : null
      const next = patchEngineer(state, engineer.id, { absentUntilDay, busyUntilDay })
      return {
        state: next,
        schedule: shiftedTaskId !== null && busyUntilDay !== null ? [{ time: busyUntilDay, priority: 'scheduled', event: { type: 'task_finished', taskId: shiftedTaskId } }] : [],
        record: { engineerId: engineer.id, absentUntilDay, shiftedTaskId, shiftedDays: shiftedTaskId === null ? 0 : event.days, busyUntilDay },
      }
    }
    case 'task_finished': {
      const task = state.tasks.find((t) => t.id === event.taskId)
      if (task === undefined) return { state, schedule: [], record: { ignored: 'unknown_task', taskId: event.taskId } }
      if (task.status !== 'in_progress') return { state, schedule: [], record: { ignored: 'not_in_progress', taskId: task.id, status: task.status } }
      const engineer = state.engineers.find((e) => e.id === task.assignedTo)
      // A `task_finished` outlives the assignment that scheduled it: an absence re-schedules it at
      // a later day, and the engineer may have moved on to other work by the time the stale copy
      // fires. Both guards ask the same question -- is this event still the one that finishes this
      // task? -- and identity is the sharper half, so it answers first.
      if (engineer !== undefined && engineer.taskId !== task.id) {
        return { state, schedule: [], record: { ignored: 'not_held', taskId: task.id, engineerId: engineer.id, holding: engineer.taskId } }
      }
      if (engineer !== undefined && engineer.busyUntilDay !== null && engineer.busyUntilDay > day) {
        return { state, schedule: [], record: { ignored: 'shifted', taskId: task.id, busyUntilDay: engineer.busyUntilDay } }
      }
      const mismatch = engineer !== undefined && engineer.expertise !== task.area
      const freed = engineer === undefined ? state : patchEngineer(state, engineer.id, { busyUntilDay: null, taskId: null })
      // §3.4: policy B reviews everything; policy A reviews only what came in as an incident.
      if (freed.reviewEverything || task.priority === 'incident') {
        return { state: patchTask(freed, task.id, { status: 'in_review', finishedDay: day }), schedule: [], record: { taskId: task.id, engineerId: engineer?.id ?? null, outcome: 'in_review', mismatch } }
      }
      // `!task.reviewed` restates §3.3's rule rather than guarding anything live: the branch above
      // already took every task the policy reviews, so nothing reviewed reaches this line.
      const defect = !task.reviewed && (mismatch || task.sizeDays >= DEFECT_SIZE_THRESHOLD)
      const done = patchTask(freed, task.id, { status: 'done', finishedDay: day, doneDay: day, reviewed: false })
      return {
        state: done,
        schedule: defect ? [{ time: day + DEFECT_DELAY_DAYS, priority: 'scheduled', event: { type: 'defect_surfaced', taskId: task.id } }] : [],
        record: { taskId: task.id, engineerId: engineer?.id ?? null, outcome: 'done', reviewed: false, mismatch, defectDay: defect ? day + DEFECT_DELAY_DAYS : null },
      }
    }
    case 'defect_surfaced': {
      const source = state.tasks.find((t) => t.id === event.taskId)
      if (source === undefined) return { state, schedule: [], record: { ignored: 'unknown_task', taskId: event.taskId } }
      const reworked = patchTask(state, source.id, { rework: source.rework + 1 })
      const created = incidentTask(reworked, { area: source.area, origin: 'defect', sourceTaskId: source.id }, day)
      return { state: created.state, schedule: [], record: { taskId: source.id, incidentTaskId: created.task.id, rework: source.rework + 1 } }
    }
  }
}

function closeDay(state: SoftwareState, day: number): Applied<SoftwareState, SoftwareEvent> & { readonly record: Readonly<Record<string, unknown>> } {
  const idleToday = state.engineers.filter((e) => isFree(e) && !isAbsent(e)).length
  const engineers = state.engineers.map((e) => (e.absentUntilDay !== null && e.absentUntilDay <= day ? { ...e, absentUntilDay: null } : e))
  const count = (status: Task['status']): number => state.tasks.filter((t) => t.status === status).length
  return {
    state: { ...state, engineers, reviewedToday: 0, idleEngineerDays: state.idleEngineerDays + idleToday },
    schedule: [],
    record: {
      queued: count('queued'), inProgress: count('in_progress'), inReview: count('in_review'), done: count('done'),
      openIncidents: state.tasks.filter((t) => t.priority === 'incident' && t.status !== 'done').length, idleToday,
    },
  }
}

/** What each role may see (§3.2). Every value is derived, not a raw state field, so an observation
 *  is already in the order the role decides in — the lead's queue is the lead's priority order. */
function observe(state: SoftwareState, role: RoleDefinition): Readonly<Record<string, unknown>> {
  const views: Readonly<Record<string, () => unknown>> = {
    requestedTasks: () => state.tasks.filter((t) => t.status === 'requested').sort((a, b) => a.requestedDay - b.requestedDay || compareTaskIds(a.id, b.id)),
    queueLength: () => state.tasks.filter((t) => t.status === 'queued').length,
    queue: () => state.tasks.filter((t) => t.status === 'queued').sort(compareQueue),
    engineers: () => [...state.engineers],   // a copy: an observation is a reading, never a handle on the state
    inReviewTasks: () => state.tasks.filter((t) => t.status === 'in_review').sort((a, b) => (a.finishedDay ?? 0) - (b.finishedDay ?? 0) || compareTaskIds(a.id, b.id)),
    matchWaitDays: () => state.matchWaitDays,
    reviewCapacityPerDay: () => state.reviewCapacityPerDay,
    reviewedToday: () => state.reviewedToday,
  }
  const out: Record<string, unknown> = {}
  for (const key of role.observes) {
    const view = views[key]
    if (view !== undefined) out[key] = view()
  }
  return out
}

/** The software sector (design §3): a queue, four engineers, expertise, review capacity, and the
 *  rework a skipped review buys three days later. */
export const softwareModel: SectorModel<SoftwareState, SoftwareEvent, SoftwareRejection> = {
  name: 'software',
  eventSchema: softwareEventSchema,
  externalEventSchema: softwareExternalEventSchema as unknown as SectorModel<SoftwareState, SoftwareEvent, SoftwareRejection>['externalEventSchema'],
  observe,
  validate,
  apply,
  applyEvent,
  closeDay,
}
