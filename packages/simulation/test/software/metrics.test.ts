import { describe, expect, it } from 'vitest'
import { runUntil } from '../../src/core/engine.js'
import type { JournalEntry } from '../../src/core/journal.js'
import { demoDefinition, softwareInitialEngineState } from '../../src/software/definition.js'
import { softwareMetrics } from '../../src/software/metrics.js'
import { softwareModel } from '../../src/software/model.js'
import { SoftwareRulesDecisionProvider } from '../../src/software/rules.js'
import { initialSoftwareState } from '../../src/software/state.js'
import { CHECKOUT_ROSTER } from './roster.js'

describe('softwareMetrics', () => {
  it('reads zero from an empty journal and an untouched state', () => {
    const state = initialSoftwareState({ engineers: [{ id: 'Alex', expertise: 'backend' }], reviewCapacityPerDay: 1, reviewEverything: false, matchWaitDays: 0 })
    expect(softwareMetrics([], state)).toEqual({
      deliveredTasks: 0, onTimeTasks: 0, lateTasks: 0, avgLeadDays: 0, reworkTasks: 0,
      defectIncidents: 0, queueMaxLength: 0, reviewBacklogMax: 0, idleEngineerDays: 0, openTasks: 0,
    })
  })

  it('counts delivery, lateness, rework and the queue and review peaks off a real run', () => {
    const definition = demoDefinition({ policy: 'A', seed: 1, roster: CHECKOUT_ROSTER, currency: 'USD' })
    const initial = softwareInitialEngineState(definition)
    const result = runUntil(softwareModel, definition, initial, new SoftwareRulesDecisionProvider(definition), definition.horizonDays, 1000)
    const state = result.state.sector
    const metrics = softwareMetrics(result.entries, state)

    expect(metrics.deliveredTasks).toBe(state.tasks.filter((t) => t.status === 'done').length)
    expect(metrics.onTimeTasks + metrics.lateTasks).toBe(metrics.deliveredTasks)
    expect(metrics.openTasks).toBe(state.tasks.filter((t) => t.status !== 'done').length)
    expect(metrics.reworkTasks).toBe(state.tasks.filter((t) => t.rework > 0).length)
    expect(metrics.defectIncidents).toBe(state.tasks.filter((t) => t.origin === 'defect').length)
    expect(metrics.idleEngineerDays).toBe(state.idleEngineerDays)
    // `avgLeadDays` is reported to a tenth of a day (ruling R7): enough resolution to tell two
    // policies apart, not enough for a float's last bit to drift between two runs.
    const done = state.tasks.filter((t) => t.doneDay !== null)
    expect(metrics.avgLeadDays).toBe(Math.round((done.reduce((s, t) => s + ((t.doneDay ?? 0) - t.requestedDay), 0) / done.length) * 10) / 10)
    // Both peaks are running maxima over the journal, so each is at least the largest the day-close
    // records ever saw — the close only ever sees what the lead and the reviewer left behind.
    const closes = result.entries.filter((e) => e.kind === 'event' && e.payload['kind'] === 'close')
    expect(metrics.queueMaxLength).toBeGreaterThanOrEqual(Math.max(...closes.map((e) => Number(e.payload['queued']))))
    expect(metrics.reviewBacklogMax).toBeGreaterThanOrEqual(Math.max(...closes.map((e) => Number(e.payload['inReview']))))
  })

  it('the peaks count work as it arrives, not what the day close was left holding', () => {
    const state = initialSoftwareState({ engineers: [{ id: 'Alex', expertise: 'backend' }], reviewCapacityPerDay: 1, reviewEverything: true, matchWaitDays: 0 })
    const entry = (seq: number, kind: JournalEntry['kind'], payload: Record<string, unknown>): JournalEntry => ({ seq, simTime: 1, kind, actorRole: null, payload })
    const journal: JournalEntry[] = [
      entry(1, 'action_applied', { action: { type: 'accept_request' }, taskId: 't-1' }),
      entry(2, 'action_applied', { action: { type: 'accept_request' }, taskId: 't-2' }),
      entry(3, 'external_event', { event: { type: 'incident' }, taskId: 't-3' }),
      // Three queued at once, then all three assigned: the peak is 3, the leftovers are 0.
      entry(4, 'action_applied', { action: { type: 'assign_task' }, taskId: 't-1' }),
      entry(5, 'action_applied', { action: { type: 'assign_task' }, taskId: 't-2' }),
      entry(6, 'action_applied', { action: { type: 'assign_task' }, taskId: 't-3' }),
      entry(7, 'event', { event: { type: 'task_finished' }, outcome: 'in_review' }),
      entry(8, 'event', { event: { type: 'task_finished' }, outcome: 'in_review' }),
      entry(9, 'action_applied', { action: { type: 'review_task' }, taskId: 't-1' }),
      entry(10, 'action_applied', { action: { type: 'review_task' }, taskId: 't-2' }),
      entry(11, 'event', { event: { type: 'defect_surfaced' }, incidentTaskId: 't-4' }),
      entry(12, 'event', { kind: 'close', queued: 1, inReview: 0 }),
    ]
    const metrics = softwareMetrics(journal, state)
    expect(metrics.queueMaxLength).toBe(3)
    expect(metrics.reviewBacklogMax).toBe(2)
    expect(metrics.defectIncidents).toBe(1)
  })
})
