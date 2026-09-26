import { describe, expect, it } from 'vitest'
import { emptyProfileSpec } from '../../src/profile/spec.js'
import { NO_WORKFLOW_PREVIEW, storedWorkflowPreview, workflowPreview } from '../../src/profile/preview.js'

const spec = (workflow: string[]) => ({ ...emptyProfileSpec(), workflow })

describe('workflowPreview', () => {
  it('is the first three steps and the whole count', () => {
    expect(workflowPreview(spec(['Read', 'Plan', 'Build', 'Test', 'Ship']))).toEqual({
      steps: ['Read', 'Plan', 'Build'],
      total: 5,
    })
  })

  it('is empty for a profile with no workflow, or only blank steps', () => {
    expect(workflowPreview(spec([]))).toEqual(NO_WORKFLOW_PREVIEW)
    expect(workflowPreview(spec(['  ', '']))).toEqual({ steps: [], total: 0 })
    expect(workflowPreview(null)).toEqual({ steps: [], total: 0 })
  })
})

describe('storedWorkflowPreview', () => {
  it('applies an operator override of the workflow', () => {
    const stored = spec(['Upstream one', 'Upstream two'])
    expect(storedWorkflowPreview(stored, { workflow: ['Mine one', 'Mine two', 'Mine three', 'Mine four'] })).toEqual({
      steps: ['Mine one', 'Mine two', 'Mine three'],
      total: 4,
    })
  })

  it('answers empty for a column that does not parse, never throws', () => {
    expect(storedWorkflowPreview(null, null)).toEqual({ steps: [], total: 0 })
    expect(storedWorkflowPreview({ nonsense: true }, undefined)).toEqual({ steps: [], total: 0 })
  })

  it('ignores an override column that does not parse and keeps the upstream steps', () => {
    expect(storedWorkflowPreview(spec(['Upstream']), { runtimeRole: 'nope' })).toEqual({ steps: ['Upstream'], total: 1 })
  })
})
