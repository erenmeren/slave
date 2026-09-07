import { describe, expect, it } from 'vitest'
import type { ActionEnvelope } from '../../src/core/action.js'
import type { RoleDefinition } from '../../src/core/sector.js'
import { softwareModel } from '../../src/software/model.js'
import { initialSoftwareState, type SoftwareState } from '../../src/software/state.js'

const ENGINEERS = [
  { id: 'Alex', expertise: 'backend' as const },
  { id: 'Emma', expertise: 'frontend' as const },
]

function base(over: Partial<{ reviewCapacityPerDay: number; reviewEverything: boolean; matchWaitDays: number }> = {}): SoftwareState {
  return initialSoftwareState({ engineers: ENGINEERS, reviewCapacityPerDay: 1, reviewEverything: false, matchWaitDays: 0, ...over })
}

const role = (name: string, allowedActions: readonly string[], constraints: Record<string, number> = {}): RoleDefinition => ({ name, purpose: '', observes: [], allowedActions: [...allowedActions], constraints, slaveName: 'someone' })
const PRODUCT = role('product', ['accept_request', 'note'])
const LEAD = role('lead', ['assign_task', 'note'], { maxAssignmentsPerStep: 4 })
const REVIEWER = role('reviewer', ['review_task', 'note'])
const env = (type: string, params: Record<string, unknown>): ActionEnvelope => ({ type, params, rationale: 'test', refs: [] })

/** Drives the model directly (no engine): a request on `day`, accepted, then assigned. */
function queued(state: SoftwareState, day: number, area: 'backend' | 'frontend' | 'devops', sizeDays: number): { state: SoftwareState; taskId: string } {
  const requested = softwareModel.applyEvent(state, { type: 'request', area, sizeDays, dueInDays: 10 }, day)
  const taskId = String(requested.record['taskId'])
  const accepted = softwareModel.apply(requested.state, PRODUCT, env('accept_request', { taskId }), day)
  return { state: accepted.state, taskId }
}

describe('software model — actions', () => {
  it('accept_request moves a requested task into the queue and stamps queuedDay', () => {
    const requested = softwareModel.applyEvent(base(), { type: 'request', area: 'backend', sizeDays: 3, dueInDays: 10 }, 1)
    const taskId = String(requested.record['taskId'])
    expect(requested.state.tasks[0]).toMatchObject({ id: 't-1', status: 'requested', origin: 'request', priority: 'normal', requestedDay: 1, dueDay: 11, queuedDay: null })
    expect(softwareModel.validate(requested.state, PRODUCT, env('accept_request', { taskId }))).toEqual({ ok: true })
    const applied = softwareModel.apply(requested.state, PRODUCT, env('accept_request', { taskId }), 1)
    expect(applied.state.tasks[0]).toMatchObject({ status: 'queued', queuedDay: 1 })
  })

  it('accept_request is rejected for an unknown task and for a task past `requested`', () => {
    const { state, taskId } = queued(base(), 1, 'backend', 3)
    expect(softwareModel.validate(state, PRODUCT, env('accept_request', { taskId: 'nope' }))).toEqual({ ok: false, reason: { kind: 'unknown_task', taskId: 'nope' } })
    expect(softwareModel.validate(state, PRODUCT, env('accept_request', { taskId }))).toEqual({ ok: false, reason: { kind: 'wrong_status', status: 'queued' } })
    expect(softwareModel.validate(state, PRODUCT, env('accept_request', {}))).toMatchObject({ ok: false, reason: { kind: 'bad_params' } })
  })

  it('assign_task takes sizeDays for a matching engineer and ceil(sizeDays * 1.5) for a mismatch', () => {
    const match = queued(base(), 1, 'backend', 3)
    const applied = softwareModel.apply(match.state, LEAD, env('assign_task', { taskId: match.taskId, engineerId: 'Alex' }), 1)
    expect(applied.state.tasks[0]).toMatchObject({ status: 'in_progress', startedDay: 1, assignedTo: 'Alex' })
    expect(applied.state.engineers[0]).toMatchObject({ busyUntilDay: 4, taskId: 't-1' })
    expect(applied.schedule).toEqual([{ time: 4, priority: 'scheduled', event: { type: 'task_finished', taskId: 't-1' } }])

    const mismatch = queued(base(), 1, 'backend', 3)
    const slow = softwareModel.apply(mismatch.state, LEAD, env('assign_task', { taskId: mismatch.taskId, engineerId: 'Emma' }), 1)
    expect(slow.state.engineers[1]?.busyUntilDay).toBe(1 + Math.ceil(3 * 1.5))
    expect(slow.schedule[0]?.time).toBe(6)
  })

  it('assign_task is rejected for an unknown task, the wrong status, an unknown, busy or absent engineer', () => {
    const { state, taskId } = queued(base(), 1, 'backend', 3)
    expect(softwareModel.validate(state, LEAD, env('assign_task', { taskId: 'nope', engineerId: 'Alex' }))).toEqual({ ok: false, reason: { kind: 'unknown_task', taskId: 'nope' } })
    expect(softwareModel.validate(state, LEAD, env('assign_task', { taskId, engineerId: 'Nobody' }))).toEqual({ ok: false, reason: { kind: 'unknown_engineer', engineerId: 'Nobody' } })

    const busy = softwareModel.apply(state, LEAD, env('assign_task', { taskId, engineerId: 'Alex' }), 1).state
    const second = queued(busy, 1, 'frontend', 1)
    expect(softwareModel.validate(second.state, LEAD, env('assign_task', { taskId: second.taskId, engineerId: 'Alex' }))).toEqual({ ok: false, reason: { kind: 'engineer_busy', engineerId: 'Alex' } })
    expect(softwareModel.validate(second.state, LEAD, env('assign_task', { taskId, engineerId: 'Emma' }))).toEqual({ ok: false, reason: { kind: 'wrong_status', status: 'in_progress' } })

    const away = softwareModel.applyEvent(second.state, { type: 'absence', engineerId: 'Emma', days: 2 }, 1).state
    expect(softwareModel.validate(away, LEAD, env('assign_task', { taskId: second.taskId, engineerId: 'Emma' }))).toEqual({ ok: false, reason: { kind: 'engineer_absent', engineerId: 'Emma' } })
  })

  it('review_task finishes a task within capacity and is rejected once the day\'s capacity is spent', () => {
    const first = queued(base({ reviewEverything: true }), 1, 'backend', 1)
    const assigned = softwareModel.apply(first.state, LEAD, env('assign_task', { taskId: first.taskId, engineerId: 'Alex' }), 1).state
    const finished = softwareModel.applyEvent(assigned, { type: 'task_finished', taskId: first.taskId }, 2)
    expect(finished.state.tasks[0]).toMatchObject({ status: 'in_review', finishedDay: 2 })

    const reviewed = softwareModel.apply(finished.state, REVIEWER, env('review_task', { taskId: first.taskId }), 2)
    expect(reviewed.state.tasks[0]).toMatchObject({ status: 'done', reviewed: true, doneDay: 2 })
    expect(reviewed.state.reviewedToday).toBe(1)

    const second = queued(reviewed.state, 2, 'frontend', 1)
    const busy = softwareModel.apply(second.state, LEAD, env('assign_task', { taskId: second.taskId, engineerId: 'Emma' }), 2).state
    const alsoFinished = softwareModel.applyEvent(busy, { type: 'task_finished', taskId: second.taskId }, 3)
    const spent = { ...alsoFinished.state, reviewedToday: 1 }
    expect(softwareModel.validate(spent, REVIEWER, env('review_task', { taskId: second.taskId }))).toEqual({ ok: false, reason: { kind: 'review_capacity_exhausted', reviewCapacityPerDay: 1 } })
  })

  it('an unknown action type is rejected as unknown_action; note is always allowed', () => {
    expect(softwareModel.validate(base(), LEAD, env('fire_someone', {}))).toEqual({ ok: false, reason: { kind: 'unknown_action', type: 'fire_someone' } })
    expect(softwareModel.validate(base(), LEAD, env('note', { text: 'hello' }))).toEqual({ ok: true })
  })
})

describe('software model — events', () => {
  it('request creates a `requested` task; incident creates a queued incident that skips product', () => {
    const incident = softwareModel.applyEvent(base(), { type: 'incident', area: 'devops' }, 4)
    expect(incident.state.tasks[0]).toMatchObject({ status: 'queued', queuedDay: 4, priority: 'incident', origin: 'incident', sizeDays: 1, area: 'devops', sourceTaskId: null })
  })

  it('absence mid-task shifts busyUntilDay and re-schedules task_finished; the stale event is ignored', () => {
    const { state, taskId } = queued(base(), 1, 'backend', 3)
    const assigned = softwareModel.apply(state, LEAD, env('assign_task', { taskId, engineerId: 'Alex' }), 1).state
    const away = softwareModel.applyEvent(assigned, { type: 'absence', engineerId: 'Alex', days: 2 }, 2)
    expect(away.state.engineers[0]).toMatchObject({ absentUntilDay: 4, busyUntilDay: 6, taskId: 't-1' })
    expect(away.schedule).toEqual([{ time: 6, priority: 'scheduled', event: { type: 'task_finished', taskId: 't-1' } }])
    expect(away.record).toMatchObject({ engineerId: 'Alex', shiftedTaskId: 't-1', shiftedDays: 2 })

    const stale = softwareModel.applyEvent(away.state, { type: 'task_finished', taskId }, 4)
    expect(stale.record).toMatchObject({ ignored: 'shifted' })
    expect(stale.state.tasks[0]?.status).toBe('in_progress')
    const real = softwareModel.applyEvent(away.state, { type: 'task_finished', taskId }, 6)
    expect(real.state.tasks[0]?.status).toBe('done')
    expect(real.state.engineers[0]).toMatchObject({ busyUntilDay: null, taskId: null })
  })

  it('task_finished is ignored when the engineer no longer holds that task', () => {
    const first = queued(base(), 1, 'backend', 3)
    const assigned = softwareModel.apply(first.state, LEAD, env('assign_task', { taskId: first.taskId, engineerId: 'Alex' }), 1).state
    // Alex is freed and picks up a second task; the first task's own `task_finished` is still in
    // the queue. Its day has come and Alex is not busy past it, so only the task id tells the two
    // apart — without that check the model would finish work that is still in progress.
    const freed = softwareModel.applyEvent(assigned, { type: 'task_finished', taskId: first.taskId }, 4).state
    const second = queued({ ...freed, tasks: freed.tasks.map((t) => (t.id === first.taskId ? { ...t, status: 'in_progress' as const, doneDay: null, finishedDay: null } : t)) }, 4, 'frontend', 1)
    const busyElsewhere = softwareModel.apply(second.state, LEAD, env('assign_task', { taskId: second.taskId, engineerId: 'Alex' }), 4).state
    const stale = softwareModel.applyEvent(busyElsewhere, { type: 'task_finished', taskId: first.taskId }, 5)
    expect(stale.record).toMatchObject({ ignored: 'not_held', taskId: 't-1' })
    expect(stale.state.tasks[0]?.status).toBe('in_progress')
    expect(stale.state.engineers[0]).toMatchObject({ taskId: 't-2', busyUntilDay: 6 })
  })

  it('absence of a free engineer shifts nothing', () => {
    const away = softwareModel.applyEvent(base(), { type: 'absence', engineerId: 'Emma', days: 1 }, 3)
    expect(away.state.engineers[1]).toMatchObject({ absentUntilDay: 4, busyUntilDay: null })
    expect(away.schedule).toEqual([])
  })

  it('the defect rule three ways: a mismatch defects, an unreviewed size ≥ 3 defects, a reviewed task never does', () => {
    // 1. mismatch, small: Emma (frontend) on a 1-day backend task.
    const a = queued(base(), 1, 'backend', 1)
    const aAssigned = softwareModel.apply(a.state, LEAD, env('assign_task', { taskId: a.taskId, engineerId: 'Emma' }), 1).state
    const aDone = softwareModel.applyEvent(aAssigned, { type: 'task_finished', taskId: a.taskId }, 3)
    expect(aDone.state.tasks[0]).toMatchObject({ status: 'done', reviewed: false })
    expect(aDone.schedule).toEqual([{ time: 6, priority: 'scheduled', event: { type: 'defect_surfaced', taskId: 't-1' } }])

    // 2. matched but big: Alex (backend) on a 3-day backend task.
    const b = queued(base(), 1, 'backend', 3)
    const bAssigned = softwareModel.apply(b.state, LEAD, env('assign_task', { taskId: b.taskId, engineerId: 'Alex' }), 1).state
    const bDone = softwareModel.applyEvent(bAssigned, { type: 'task_finished', taskId: b.taskId }, 4)
    expect(bDone.schedule).toEqual([{ time: 7, priority: 'scheduled', event: { type: 'defect_surfaced', taskId: 't-1' } }])

    // 3. matched and small: nothing surfaces.
    const c = queued(base(), 1, 'backend', 2)
    const cAssigned = softwareModel.apply(c.state, LEAD, env('assign_task', { taskId: c.taskId, engineerId: 'Alex' }), 1).state
    expect(softwareModel.applyEvent(cAssigned, { type: 'task_finished', taskId: c.taskId }, 3).schedule).toEqual([])

    // 4. reviewed: the policy sends it to review instead, so no defect is ever scheduled.
    const d = queued(base({ reviewEverything: true }), 1, 'backend', 3)
    const dAssigned = softwareModel.apply(d.state, LEAD, env('assign_task', { taskId: d.taskId, engineerId: 'Emma' }), 1).state
    const dFinished = softwareModel.applyEvent(dAssigned, { type: 'task_finished', taskId: d.taskId }, 6)
    expect(dFinished.state.tasks[0]?.status).toBe('in_review')
    expect(dFinished.schedule).toEqual([])
  })

  it('an incident-priority task goes to review under policy A too', () => {
    const incident = softwareModel.applyEvent(base(), { type: 'incident', area: 'backend' }, 1)
    const taskId = String(incident.record['taskId'])
    const assigned = softwareModel.apply(incident.state, LEAD, env('assign_task', { taskId, engineerId: 'Alex' }), 1).state
    const finished = softwareModel.applyEvent(assigned, { type: 'task_finished', taskId }, 2)
    expect(finished.state.tasks[0]?.status).toBe('in_review')
  })

  it('defect_surfaced adds rework to the source and queues a 1-day incident carrying its area', () => {
    const { state, taskId } = queued(base(), 1, 'backend', 3)
    const assigned = softwareModel.apply(state, LEAD, env('assign_task', { taskId, engineerId: 'Alex' }), 1).state
    const done = softwareModel.applyEvent(assigned, { type: 'task_finished', taskId }, 4).state
    const surfaced = softwareModel.applyEvent(done, { type: 'defect_surfaced', taskId }, 7)
    expect(surfaced.state.tasks[0]?.rework).toBe(1)
    expect(surfaced.state.tasks[1]).toMatchObject({ id: 't-2', origin: 'defect', priority: 'incident', status: 'queued', queuedDay: 7, area: 'backend', sizeDays: 1, sourceTaskId: 't-1' })
    expect(surfaced.record).toMatchObject({ taskId: 't-1', incidentTaskId: 't-2' })
  })
})

describe('software model — closeDay', () => {
  it('resets reviewedToday, counts idle engineer-days, clears expired absences and reports the board', () => {
    const { state, taskId } = queued(base(), 1, 'backend', 3)
    const assigned = softwareModel.apply(state, LEAD, env('assign_task', { taskId, engineerId: 'Alex' }), 1).state
    const withAbsence = softwareModel.applyEvent(assigned, { type: 'absence', engineerId: 'Emma', days: 1 }, 1).state
    // Alex is busy, Emma is absent today: nobody is idle.
    const day1 = softwareModel.closeDay({ ...withAbsence, reviewedToday: 1 }, 1)
    expect(day1.state.reviewedToday).toBe(0)
    expect(day1.state.idleEngineerDays).toBe(0)
    expect(day1.state.engineers[1]?.absentUntilDay).toBe(2)
    expect(day1.record).toMatchObject({ queued: 0, inProgress: 1, inReview: 0, done: 0, openIncidents: 0, idleToday: 0 })

    // Day 2 is Emma's last day away (`absentUntilDay` is inclusive), so she still counts as
    // absent, not idle; the close then clears the field and day 3 counts her as idle.
    const day2 = softwareModel.closeDay(day1.state, 2)
    expect(day2.state.idleEngineerDays).toBe(0)
    expect(day2.state.engineers[1]?.absentUntilDay).toBeNull()
    const day3 = softwareModel.closeDay(day2.state, 3)
    expect(day3.state.idleEngineerDays).toBe(1)
  })
})
