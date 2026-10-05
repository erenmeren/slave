import { prisma } from '@slave-of-ai/db/client'
import { LEAD_ROSTER_MAX, LEAD_TEAM_NAME, type IntakeDraft } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readIntake } from '../../src/intake.js'
import { fillLeadRoster, fillLeadRosterFromIntake, personsForPersonas } from '../../src/lead/autoRoster.js'
import { projectView } from '../../src/projectView.js'

const persona = async (name: string, division: string | null = 'engineering', description = ''): Promise<string> =>
  (await prisma.slaveTemplate.create({ data: { name, role: 'backend', description, active: true, sourceDivision: division } })).id

const project = async (name: string, flow: 'lead' | 'packages' = 'lead', leadRoster: readonly string[] = []): Promise<string> =>
  (await prisma.workspace.create({ data: { name, repoPath: '/tmp/no-such-repo', verifyCommands: ['true'], setupCommands: [], flow, delivery: 'conducted', leadRoster: [...leadRoster] } })).id

const draftWith = (team: IntakeDraft['team']): IntakeDraft => ({
  name: 'Keys',
  goal: 'Manage keys',
  repo: { mode: 'new', path: null },
  baseBranch: 'main',
  verifyCommands: [],
  setupCommands: [],
  budgetUsd: null,
  provider: null,
  autoMerge: true,
  autonomy: 'act',
  delivery: 'conducted',
  team,
})

/** The conversation that created `workspaceId`, with the card it was created from. */
const conversation = async (workspaceId: string | null, team: IntakeDraft['team'] | null): Promise<string> =>
  (await prisma.intake.create({ data: { status: workspaceId === null ? 'drafted' : 'created', workspaceId, ...(team === null ? {} : { draft: draftWith(team) }) } })).id

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "IntakeMessage", "Intake", "GoalDelivery", "Slave", "Person", "Team", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE')
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('a roster from personas', () => {
  it('takes one person of each persona, each persona once, at most the roster s size', async () => {
    const ids: string[] = []
    for (let n = 0; n < LEAD_ROSTER_MAX + 2; n += 1) ids.push(await persona(`Persona ${String(n).padStart(2, '0')}`))
    const first = ids[0] as string
    const persons = await personsForPersonas([first, first, ...ids])
    expect(persons.ok).toBe(true)
    if (!persons.ok) return
    expect(persons.value).toHaveLength(LEAD_ROSTER_MAX)
    expect(new Set(persons.value).size).toBe(LEAD_ROSTER_MAX)
    // Asked again, the same people answer: nobody new is made.
    expect(await personsForPersonas(ids)).toEqual({ ok: true, value: persons.value })
    expect(await prisma.person.count()).toBe(LEAD_ROSTER_MAX)
  })

  it('never takes a system person of some project s lead flow', async () => {
    const templateId = await persona('Backend Developer')
    const workspaceId = await project('Other')
    const team = await prisma.team.create({ data: { workspaceId, name: LEAD_TEAM_NAME } })
    const system = await prisma.person.create({ data: { name: 'Lead 1234', templateId } })
    await prisma.slave.create({ data: { teamId: team.id, personId: system.id, role: 'Lead', runtimeRoles: [] } })
    const persons = await personsForPersonas([templateId])
    expect(persons.ok && persons.value[0] !== system.id).toBe(true)
    expect(await prisma.person.count({ where: { templateId } })).toBe(2)
  })

  it('leaves a roster somebody already chose exactly as it is', async () => {
    const templateId = await persona('Backend Developer')
    const ada = await prisma.person.create({ data: { name: 'Ada' } })
    const workspaceId = await project('Chosen', 'lead', [ada.id])
    expect(await fillLeadRoster(workspaceId, [templateId])).toEqual({ ok: true, value: { roster: [ada.id], written: false } })
    expect(await prisma.person.count()).toBe(1)
  })

  it('refuses a project of the packages flow and one that does not exist', async () => {
    const templateId = await persona('Backend Developer')
    const workspaceId = await project('Older', 'packages')
    expect(await fillLeadRoster(workspaceId, [templateId])).toMatchObject({ ok: false, error: { kind: 'not_lead_flow' } })
    expect(await fillLeadRoster('00000000-0000-4000-8000-000000000000', [templateId])).toMatchObject({ ok: false, error: { kind: 'workspace_not_found' } })
    expect(await prisma.person.count()).toBe(0)
  })
})

describe('the roster of a project created before it filled itself', () => {
  it('puts the people its conversation proposed on the roster, and the Project screen stops offering it', async () => {
    const backend = await persona('Backend Developer', 'engineering', '  Builds APIs.  ')
    const qa = await persona('QA Engineer', 'testing')
    const workspaceId = await project('Keys')
    await conversation(workspaceId, [{ templateId: backend, runtimeRoles: ['backend', 'manager'] }, { templateId: qa, runtimeRoles: ['reviewer'] }, { templateId: backend, runtimeRoles: ['backend'] }])

    const before = await projectView(workspaceId)
    expect(before.ok && before.value).toMatchObject({ roster: [], rosterProposed: 2 })

    const filled = await fillLeadRosterFromIntake(workspaceId)
    expect(filled).toMatchObject({ ok: true, value: { written: true } })
    if (!filled.ok) return
    expect(filled.value.roster).toHaveLength(2)

    const after = await projectView(workspaceId)
    expect(after.ok && after.value).toMatchObject({
      rosterProposed: 0,
      roster: [
        { id: filled.value.roster[0], name: 'Backend Developer', role: 'backend', division: 'engineering', description: 'Builds APIs.' },
        { id: filled.value.roster[1], name: 'QA Engineer', division: 'testing', description: '' },
      ],
    })

    // A second run changes nothing and says why.
    expect(await fillLeadRosterFromIntake(workspaceId)).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'roster' } })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).leadRoster).toEqual(filled.value.roster)
    expect(await prisma.person.count()).toBe(2)
  })

  it('refuses, writing nothing, a project no conversation created and one whose conversation proposed nobody', async () => {
    const byHand = await project('By hand')
    expect(await fillLeadRosterFromIntake(byHand)).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'roster', rule: expect.stringContaining('no conversation') } })
    const nobody = await project('Nobody')
    await conversation(nobody, [])
    expect(await fillLeadRosterFromIntake(nobody)).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'roster', rule: expect.stringContaining('proposed nobody') } })
    const older = await project('Older', 'packages')
    expect(await fillLeadRosterFromIntake(older)).toMatchObject({ ok: false, error: { kind: 'not_lead_flow' } })
    expect(await prisma.person.count()).toBe(0)
    const view = await projectView(nobody)
    expect(view.ok && view.value.rosterProposed).toBe(0)
  })
})

describe('the conversation s card names its proposed people', () => {
  it('reads each persona of the draft s team once, in its order, and leaves out one the catalogue no longer has', async () => {
    const backend = await persona('Backend Developer', 'engineering', 'Builds APIs.')
    const handMade = await persona('House Style', null)
    const id = await conversation(null, [
      { templateId: handMade, runtimeRoles: [] },
      { templateId: 'gone', runtimeRoles: [] },
      { templateId: backend, runtimeRoles: ['backend'] },
      { templateId: handMade, runtimeRoles: ['docs'] },
    ])
    const view = await readIntake(id)
    expect(view.ok && view.value.team).toEqual([
      { templateId: handMade, name: 'House Style', role: 'backend', division: null, description: '' },
      { templateId: backend, name: 'Backend Developer', role: 'backend', division: 'engineering', description: 'Builds APIs.' },
    ])
    const empty = await readIntake(await conversation(null, null))
    expect(empty.ok && empty.value.team).toEqual([])
  })
})
