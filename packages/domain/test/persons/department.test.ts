import { describe, expect, it } from 'vitest'
import { MANAGER_ROLE, REVIEWER_ROLE } from '../../src/supervisor/constants.js'
import { FUNCTIONAL_DEPARTMENTS, functionalDepartmentFor } from '../../src/persons/department.js'

describe('functionalDepartmentFor (Catalog Person Pool Task 4)', () => {
  it.each([
    ['engineering', 'Engineering'],
    ['frontend', 'Engineering'],
    ['backend', 'Engineering'],
    ['database', 'Engineering'],
    ['mobile', 'Engineering'],
    ['security', 'Engineering'],
    ['data', 'Engineering'],
    ['game-development', 'Engineering'],
    ['gis', 'Engineering'],
    ['spatial-computing', 'Engineering'],
    ['product', 'Product'],
    ['project-management', 'Product'],
    ['manager', 'Product'],
    ['research', 'Product'],
    ['docs', 'Product'],
    ['design', 'Design'],
    ['marketing', 'Marketing'],
    ['sales', 'Marketing'],
    ['paid-media', 'Marketing'],
    ['qa', 'QA'],
    ['testing', 'QA'],
    ['reviewer', 'QA'],
    ['operations', 'Operations'],
    ['support', 'Operations'],
  ] as const)('maps the primary role %s to %s', (role, department) => {
    expect(functionalDepartmentFor(role, [])).toBe(department)
  })

  it.each(['specialized', 'academic', 'finance', 'healthcare', 'astrology', ''] as const)(
    'falls back to Specialists for an unknown primary role %s with no mapped runtime roles',
    (role) => {
      expect(functionalDepartmentFor(role, [])).toBe('Specialists')
    },
  )

  it('never guesses: an unmapped primary role with no mapped runtime roles is Specialists', () => {
    expect(functionalDepartmentFor('specialized', ['specialized', 'unmapped-thing'])).toBe('Specialists')
  })

  it('chooses the primary role over every runtime role, mapped or not', () => {
    // `frontend` is Engineering; `manager` alone would be Product. The primary role wins outright.
    expect(functionalDepartmentFor('frontend', ['manager'])).toBe('Engineering')
  })

  it('does not let manager/reviewer, added as support duties, move an engineering specialist', () => {
    // `ensureStaffRoles` appends MANAGER_ROLE/REVIEWER_ROLE to one seat's own runtimeRoles; the
    // template's own primary role still decides the department.
    expect(functionalDepartmentFor('backend', ['backend', MANAGER_ROLE, REVIEWER_ROLE])).toBe('Engineering')
  })

  it('does not let manager/reviewer move a marketing specialist into Product/QA', () => {
    expect(functionalDepartmentFor('sales', ['sales', MANAGER_ROLE])).toBe('Marketing')
    expect(functionalDepartmentFor('marketing', ['marketing', REVIEWER_ROLE])).toBe('Marketing')
  })

  it('falls back to the first mapped runtime role, in approved order, only when the primary role has none', () => {
    expect(functionalDepartmentFor('specialized', ['docs', 'marketing'])).toBe('Product')
    expect(functionalDepartmentFor('academic', ['marketing', 'docs'])).toBe('Marketing')
  })

  it('honours a manager/reviewer runtime role in the fallback scan when the primary role has no mapping', () => {
    // Unlike the primary-role case above, a genuinely unmapped persona holding `manager` as a
    // runtime role really is doing management work, and the mapping table says so explicitly.
    expect(functionalDepartmentFor('specialized', [MANAGER_ROLE])).toBe('Product')
    expect(functionalDepartmentFor('academic', [REVIEWER_ROLE])).toBe('QA')
  })

  it('falls back to Specialists when neither the primary role nor any runtime role maps', () => {
    expect(functionalDepartmentFor('specialized', ['academic', 'finance', 'healthcare'])).toBe('Specialists')
  })

  it('defaults runtimeRoles to empty when omitted', () => {
    expect(functionalDepartmentFor('backend')).toBe('Engineering')
    expect(functionalDepartmentFor('specialized')).toBe('Specialists')
  })

  it('is a total function over the exported department list', () => {
    expect(FUNCTIONAL_DEPARTMENTS).toEqual(['Engineering', 'Product', 'Design', 'Marketing', 'QA', 'Operations', 'Specialists'])
  })
})
