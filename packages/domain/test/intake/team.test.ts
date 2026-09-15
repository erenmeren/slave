import { describe, expect, it } from 'vitest'
import { ensureStaffRoles, MANAGER_ROLE, REVIEWER_ROLE, type IntakeCatalogueEntry } from '../../src/index.js'

const catalogue: readonly IntakeCatalogueEntry[] = [
  { templateId: 'writer', name: 'Technical Writer', division: 'communications', role: 'writer' },
  { templateId: 'backend', name: 'Backend Developer', division: 'engineering', role: 'backend' },
]

describe('ensureStaffRoles', () => {
  it('leaves a team that already has both alone', () => {
    const team = [{ templateId: 'backend', runtimeRoles: ['backend', MANAGER_ROLE, REVIEWER_ROLE] }]
    expect(ensureStaffRoles(team, catalogue)).toEqual(team)
  })

  it('adds both to the first engineering seat, because dispatchPlanning refuses without a manager', () => {
    const seats = ensureStaffRoles(
      [
        { templateId: 'writer', runtimeRoles: ['writer'] },
        { templateId: 'backend', runtimeRoles: ['backend'] },
      ],
      catalogue,
    )
    expect(seats).toEqual([
      { templateId: 'writer', runtimeRoles: ['writer'] },
      { templateId: 'backend', runtimeRoles: ['backend', MANAGER_ROLE, REVIEWER_ROLE] },
    ])
  })

  it('adds only what is missing, and never twice', () => {
    const seats = ensureStaffRoles([{ templateId: 'backend', runtimeRoles: ['backend', MANAGER_ROLE] }], catalogue)
    expect(seats[0]?.runtimeRoles).toEqual(['backend', MANAGER_ROLE, REVIEWER_ROLE])
  })

  it('falls back to the first seat when no division looks like engineering', () => {
    const seats = ensureStaffRoles([{ templateId: 'writer', runtimeRoles: ['writer'] }], catalogue)
    expect(seats[0]?.runtimeRoles).toEqual(['writer', MANAGER_ROLE, REVIEWER_ROLE])
  })

  it('leaves an EMPTY team empty -- "I will staff it myself" is allowed (R13)', () => {
    expect(ensureStaffRoles([], catalogue)).toEqual([])
  })

  it('tolerates a seat naming a template the catalogue does not carry', () => {
    const seats = ensureStaffRoles([{ templateId: 'gone', runtimeRoles: [] }], catalogue)
    expect(seats[0]?.runtimeRoles).toEqual([MANAGER_ROLE, REVIEWER_ROLE])
  })
})
