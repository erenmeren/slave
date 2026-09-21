import { describe, expect, it } from 'vitest'
import { DEFAULT_GUARDRAIL_LIMITS } from '../../src/guardrails/evaluate.js'
import { slaveId, taskId } from '../../src/ids.js'
import { chooseAssignee, holdsRole, type AssignableSeat } from '../../src/scheduler/assign.js'
import { decide } from '../../src/scheduler/decide.js'

function seat(id: string, overrides: Partial<AssignableSeat> = {}): AssignableSeat {
  return { id, runtimeRoles: ['backend'], busy: false, closed: false, released: false, ...overrides }
}

describe('chooseAssignee', () => {
  it('names the one seat that holds the role', () => {
    expect(chooseAssignee('backend', [seat('beryl'), seat('emma', { runtimeRoles: ['frontend'] })])).toBe('beryl')
  })

  it('is null when nobody holds the role', () => {
    expect(chooseAssignee('design', [seat('beryl'), seat('emma', { runtimeRoles: ['frontend'] })])).toBeNull()
  })

  it('is null on a project with no seats at all', () => {
    expect(chooseAssignee('backend', [])).toBeNull()
  })

  it('prefers a holder who is free over one mid-run', () => {
    expect(chooseAssignee('backend', [seat('alex', { busy: true }), seat('beryl')])).toBe('beryl')
  })

  it('still names a BUSY holder rather than leaving the task with nobody', () => {
    // A role held only by somebody mid-run is still a role this project serves -- the same
    // distinction `staffedRolesForWorkspace` makes. The task is theirs; it waits for them.
    expect(chooseAssignee('backend', [seat('alex', { busy: true })])).toBe('alex')
  })

  it('breaks a tie on the lowest id, whatever order the seats arrive in', () => {
    const forwards = chooseAssignee('backend', [seat('alex'), seat('beryl')])
    const backwards = chooseAssignee('backend', [seat('beryl'), seat('alex')])
    expect(forwards).toBe('alex')
    expect(backwards).toBe('alex')
  })

  it('prefers the free holder over a lower-id busy one', () => {
    expect(chooseAssignee('backend', [seat('alex', { busy: true }), seat('zoe')])).toBe('zoe')
  })

  it('leaves out a closed seat', () => {
    expect(chooseAssignee('backend', [seat('alex', { closed: true })])).toBeNull()
    expect(chooseAssignee('backend', [seat('alex', { closed: true }), seat('beryl')])).toBe('beryl')
  })

  it('leaves out a seat whose person has been released', () => {
    expect(chooseAssignee('backend', [seat('alex', { released: true })])).toBeNull()
    expect(chooseAssignee('backend', [seat('alex', { released: true }), seat('beryl')])).toBe('beryl')
  })

  it('gives an empty required role to nobody, as dispatch does', () => {
    // `''` is a real value on the column -- a task no role was derived for -- and no seat's role
    // list contains it, so nobody holds it. `decide()` reasons about the same string the same way.
    expect(chooseAssignee('', [seat('alex'), seat('beryl', { runtimeRoles: [] })])).toBeNull()
  })

  it('names the seat dispatch would hand the task to, when one seat holds the role', () => {
    // The two must agree on "holds the role" or a card names one person and the run belongs to
    // another. They share `holdsRole` for exactly that reason; this is the guard on the sharing.
    const seats = [seat('beryl'), seat('emma', { runtimeRoles: ['frontend'] })]
    const commands = decide({
      tasks: [{ id: taskId('TASK-1'), status: 'ready', requiredRole: 'backend', priority: 1, dependenciesDone: true }],
      slaves: seats.map((one) => ({ id: slaveId(one.id), runtimeRoles: one.runtimeRoles, busy: one.busy })),
      limits: DEFAULT_GUARDRAIL_LIMITS,
      stats: { activeRuns: 0, globalActiveRuns: 0, spentUsd: 0, consecutiveFailures: 0, emergencyStopped: false },
    })

    expect(commands).toEqual([{ kind: 'start_run', taskId: 'TASK-1', slaveId: 'beryl' }])
    expect(chooseAssignee('backend', seats)).toBe('beryl')
  })
})

describe('holdsRole', () => {
  it('is the role list membership dispatch matches on', () => {
    expect(holdsRole({ runtimeRoles: ['backend', 'reviewer'] }, 'reviewer')).toBe(true)
    expect(holdsRole({ runtimeRoles: ['backend'] }, 'reviewer')).toBe(false)
  })

  it('is false for a seat with no runtime roles at all, including for the empty role', () => {
    expect(holdsRole({ runtimeRoles: [] }, 'backend')).toBe(false)
    expect(holdsRole({ runtimeRoles: [] }, '')).toBe(false)
  })
})
