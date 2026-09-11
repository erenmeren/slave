import { describe, expect, it } from 'vitest'
import { measureAdherence } from '../../src/runbook/adherence.js'
import type { RunbookStage } from '../../src/runbook/spec.js'

const STAGES: readonly RunbookStage[] = [
  { key: 'design', title: 'Design', objective: 'Decide', capabilities: [], dependsOn: [], expectedOutputs: [], gates: [], retry: null, escalation: null },
  { key: 'implement', title: 'Implement', objective: 'Build', capabilities: [], dependsOn: ['design'], expectedOutputs: [], gates: [], retry: null, escalation: null },
  { key: 'verify', title: 'Verify', objective: 'Prove', capabilities: [], dependsOn: ['implement'], expectedOutputs: [], gates: [], retry: null, escalation: null },
]

describe('measureAdherence', () => {
  it('reports covered and missing stages in stage order, never in task order', () => {
    const out = measureAdherence(STAGES, [
      { id: 't1', stage: 'verify', status: 'ready' },
      { id: 't2', stage: 'design', status: 'done' },
    ])
    expect(out.stagesCovered).toEqual(['design', 'verify'])
    expect(out.stagesMissing).toEqual(['implement'])
  })

  it('names a stage the runbook does not have rather than dropping it', () => {
    const out = measureAdherence(STAGES, [{ id: 't1', stage: 'polish', status: 'ready' }])
    expect(out.unknownStages).toEqual(['polish'])
    expect(out.stagesCovered).toEqual([])
  })

  it('the current stage is the first in order with any non-terminal task', () => {
    expect(
      measureAdherence(STAGES, [
        { id: 't1', stage: 'design', status: 'done' },
        { id: 't2', stage: 'implement', status: 'running' },
        { id: 't3', stage: 'verify', status: 'ready' },
      ]).currentStage,
    ).toBe('implement')
  })

  it('is the LAST stage once every task is terminal -- the work is finished, not unstarted', () => {
    expect(
      measureAdherence(STAGES, [
        { id: 't1', stage: 'design', status: 'done' },
        { id: 't2', stage: 'implement', status: 'cancelled' },
      ]).currentStage,
    ).toBe('verify')
  })

  // Plan erratum E7: "every task is terminal" is vacuously true over zero tasks.
  it('is the FIRST stage on an empty board: a runbook adopted before the plan has not finished', () => {
    expect(measureAdherence(STAGES, []).currentStage).toBe('design')
  })

  it('has no current stage when the runbook has no stages at all', () => {
    expect(measureAdherence([], []).currentStage).toBeNull()
  })

  it('ignores a task with no stage: a hand-made task is not evidence about a runbook', () => {
    const out = measureAdherence(STAGES, [{ id: 't1', stage: null, status: 'running' }])
    expect(out.stagesCovered).toEqual([])
    expect(out.currentStage).toBe('design')
  })
})
