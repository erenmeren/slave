import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import { clearStaffingPreference, listStaffingPreferences, setStaffingPreference } from '../../src/staffing.js'
import { BACKEND_SERVICES_LABEL, seedEvidenceFixture, type EvidenceFixture } from './fixtures/evidence.js'

let fixture: EvidenceFixture
beforeEach(async (): Promise<void> => {
  fixture = await seedEvidenceFixture()
})

describe('setStaffingPreference (M53 R9)', () => {
  it('writes one row per capability per project, and names the granting principal', async (): Promise<void> => {
    const result = await setStaffingPreference(
      fixture.workspaceId,
      { capability: 'backend.services', templateId: fixture.templateId },
      { userId: 'u1' },
    )
    expect(result.ok).toBe(true)
    const row = await prisma.staffingPreference.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect(row.capability).toBe('backend.services')
    expect(row.templateId).toBe(fixture.templateId)
    expect(row.setBy).toBe('u1')
  })

  it('replaces the decision in place rather than stacking a second row', async (): Promise<void> => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', templateId: fixture.templateId })
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    const rows = await prisma.staffingPreference.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.templateId).toBeNull()
    expect(rows[0]?.model).toBe('opus')
  })

  it('accepts BOTH halves -- "Atlas, and on opus" is one decision', async (): Promise<void> => {
    const result = await setStaffingPreference(fixture.workspaceId, {
      capability: 'backend.services',
      templateId: fixture.templateId,
      model: 'opus',
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a row naming NEITHER, before any write', async (): Promise<void> => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services' })
    expect(result.ok === false && result.error.kind).toBe('invalid_staffing_preference')
    expect(result.ok === false && refusalText(result.error)).toBe(
      'a staffing preference for backend.services must name a profile, a model, or both',
    )
    expect(await prisma.staffingPreference.count()).toBe(0)
  })

  it('refuses a capability the taxonomy does not have, reusing the existing kind', async (): Promise<void> => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'nowhere.at-all', model: 'opus' })
    expect(result.ok === false && result.error.kind).toBe('capability_not_found')
  })

  it('refuses a template this installation does not have', async (): Promise<void> => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', templateId: 'missing' })
    expect(result.ok === false && result.error.kind).toBe('template_not_found')
  })

  it('refuses a model whose shape is not a model name, with the existing kind and a TRUE sentence', async (): Promise<void> => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'not a model!' })
    expect(result.ok === false && result.error.kind).toBe('invalid_model')
    // Fix round 1, Important 1: the kind is reused, so the SENTENCE has to carry the rule. The
    // default one ("a model must be a non-empty text") was written for `setSlaveModel` and would
    // tell an operator that `gpt 4o` is empty.
    expect(result.ok === false && refusalText(result.error)).toBe(
      'a model must be one word: a letter or digit, then any of . _ - : @ / — and no spaces',
    )
  })

  it('accepts every model id shape this product actually dispatches with', async (): Promise<void> => {
    for (const model of ['opus', 'claude-sonnet-4-20250514', 'us.anthropic.claude-opus-4:1', 'gpt-4o']) {
      const result = await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model })
      expect(result.ok, model).toBe(true)
    }
  })

  it('refuses a project that is not there', async (): Promise<void> => {
    const result = await setStaffingPreference('missing', { capability: 'backend.services', model: 'opus' })
    expect(result.ok === false && result.error.kind).toBe('workspace_not_found')
  })

  it('appends `staffing.preference_changed` with from, to and by -- and the LABEL beside the key', async (): Promise<void> => {
    await setStaffingPreference(
      fixture.workspaceId,
      { capability: 'backend.services', templateId: fixture.templateId },
      { userId: 'u1' },
    )
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { type: 'staffing_preference_changed' },
      orderBy: { seq: 'desc' },
    })
    expect(event.payload).toMatchObject({
      capability: 'backend.services',
      capabilityLabel: BACKEND_SERVICES_LABEL,
      from: null,
      to: { templateId: fixture.templateId, templateName: 'Backend Developer', model: null },
      by: 'u1',
    })
  })

  it('carries the PRIOR decision as `from` when one is replaced', async (): Promise<void> => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', templateId: fixture.templateId })
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { type: 'staffing_preference_changed' },
      orderBy: { seq: 'desc' },
    })
    expect(event.payload).toMatchObject({
      from: { templateId: null, templateName: null, model: 'opus' },
      to: { templateId: fixture.templateId, templateName: 'Backend Developer', model: null },
    })
  })

  it('writes NO event when the decision is already exactly this', async (): Promise<void> => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    const before = await prisma.executionEvent.count({ where: { type: 'staffing_preference_changed' } })
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    expect(await prisma.executionEvent.count({ where: { type: 'staffing_preference_changed' } })).toBe(before)
  })
})

describe('clearStaffingPreference (M53 R9)', () => {
  it('deletes the row and appends the change with `to: null`', async (): Promise<void> => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    const result = await clearStaffingPreference(fixture.workspaceId, 'backend.services', { userId: 'u1' })
    expect(result.ok).toBe(true)
    expect(await prisma.staffingPreference.count()).toBe(0)
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { type: 'staffing_preference_changed' },
      orderBy: { seq: 'desc' },
    })
    expect((event.payload as { to: unknown }).to).toBeNull()
  })

  it('clearing nothing is SUCCESS and writes no event -- what DELETE promises', async (): Promise<void> => {
    const result = await clearStaffingPreference(fixture.workspaceId, 'backend.services')
    expect(result.ok).toBe(true)
    expect(await prisma.executionEvent.count({ where: { type: 'staffing_preference_changed' } })).toBe(0)
  })
})

describe('listStaffingPreferences (M53 R9)', () => {
  it('answers the decisions of one project, capability ascending, with the words beside the keys', async (): Promise<void> => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'qa.test-automation', model: 'opus' })
    await setStaffingPreference(
      fixture.workspaceId,
      { capability: 'backend.services', templateId: fixture.templateId },
      { userId: 'u1' },
    )
    expect(await listStaffingPreferences(fixture.workspaceId)).toEqual([
      {
        capability: 'backend.services',
        capabilityLabel: BACKEND_SERVICES_LABEL,
        templateId: fixture.templateId,
        templateName: 'Backend Developer',
        model: null,
        setBy: 'u1',
        setAt: expect.any(Date),
      },
      {
        capability: 'qa.test-automation',
        capabilityLabel: 'Test automation',
        templateId: null,
        templateName: null,
        model: 'opus',
        setBy: null,
        setAt: expect.any(Date),
      },
    ])
  })
})

describe('the refusal is a RETURNED value, never a throw after a write', () => {
  it('leaves no row behind on any refusal path', async (): Promise<void> => {
    for (const input of [
      { capability: 'backend.services' },
      { capability: 'nowhere.at-all', model: 'opus' },
      { capability: 'backend.services', templateId: 'missing' },
    ]) {
      await setStaffingPreference(fixture.workspaceId, input)
    }
    expect(await prisma.staffingPreference.count()).toBe(0)
    expect(await prisma.executionEvent.count({ where: { type: 'staffing_preference_changed' } })).toBe(0)
  })
})
