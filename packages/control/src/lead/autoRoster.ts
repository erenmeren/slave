import { prisma } from '@slave-of-ai/db/client'
import { LEAD_ROSTER_MAX, LEAD_TEAM_NAME, err, intakeDraftSchema, ok, type Result } from '@slave-of-ai/domain'
import { createPerson } from '../persons.js'
import type { ControlRefusal } from '../refusal.js'

/** What {@link fillLeadRoster} left on the project. `written` is false when it changed nothing. */
export interface FilledRoster {
  readonly roster: readonly string[]
  readonly written: boolean
}

/**
 * One person per persona, in the order given, each persona once, at most `LEAD_ROSTER_MAX`: the
 * persons a roster is made of when somebody chose personas rather than people. An unreleased
 * person of the persona is taken as they are -- their pool persons first, by slot, then the oldest
 * hired by hand; the lead flow's own system persons are never taken. Only a persona nobody was
 * ever hired from gets a new person (`createPerson`), so running it again finds that person and
 * makes nobody. Reads, and writes only that new person.
 */
export async function personsForPersonas(templateIds: readonly string[]): Promise<Result<readonly string[], ControlRefusal>> {
  const personas = [...new Set(templateIds)].slice(0, LEAD_ROSTER_MAX)
  const known = new Set((await prisma.slaveTemplate.findMany({ where: { id: { in: personas } }, select: { id: true } })).map((row) => row.id))
  // Every persona is checked before anybody is made: a refusal leaves no person behind.
  const unknown = personas.find((templateId) => !known.has(templateId))
  if (unknown !== undefined) return err({ kind: 'template_not_found', templateId: unknown })
  const persons: string[] = []
  for (const templateId of personas) {
    const found = await prisma.person.findFirst({
      where: { templateId, releasedAt: null, seats: { none: { team: { name: LEAD_TEAM_NAME } } } },
      orderBy: [{ poolSlot: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    if (found !== null) {
      persons.push(found.id)
      continue
    }
    const created = await createPerson({ templateId })
    if (!created.ok) return created
    persons.push(created.value.personId)
  }
  return ok(persons)
}

/**
 * A lead-flow project's roster, filled from personas: the helpers its lead may call on are one
 * person of each (see {@link personsForPersonas}). A roster that already names somebody is left
 * exactly as it is -- `written: false` -- so a repeat (an accept that is resumed) changes nothing
 * and a roster a person chose by hand is never overwritten; the write itself is conditional on the
 * roster still being empty.
 */
export async function fillLeadRoster(workspaceId: string, templateIds: readonly string[]): Promise<Result<FilledRoster, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { flow: true, leadRoster: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.flow !== 'lead') return err({ kind: 'not_lead_flow', workspaceId })
  if (workspace.leadRoster.length > 0) return ok({ roster: workspace.leadRoster, written: false })
  const persons = await personsForPersonas(templateIds)
  if (!persons.ok) return persons
  if (persons.value.length === 0) return ok({ roster: [], written: false })
  const written = await prisma.workspace.updateMany({ where: { id: workspaceId, leadRoster: { isEmpty: true } }, data: { leadRoster: [...persons.value] } })
  if (written.count === 0) {
    const now = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { leadRoster: true } })
    return ok({ roster: now?.leadRoster ?? [], written: false })
  }
  return ok({ roster: persons.value, written: true })
}

/** The personas the conversation that created a project proposed, in the draft's order, each once. */
export async function proposedPersonas(workspaceId: string): Promise<readonly string[] | null> {
  const intake = await prisma.intake.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, select: { draft: true } })
  if (intake === null || intake.draft === null) return null
  const draft = intakeDraftSchema.safeParse(intake.draft)
  return draft.success ? [...new Set(draft.data.team.map((seat) => seat.templateId))] : null
}

/**
 * The one-off for a project created before its roster filled itself: the people proposed in the
 * conversation that created it become its roster. Refused, with nothing written, for a project no
 * conversation created, one whose conversation proposed nobody, and one whose roster already names
 * somebody (edit that one by hand: `setLeadSettings`).
 */
export async function fillLeadRosterFromIntake(workspaceId: string): Promise<Result<FilledRoster, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { flow: true, leadRoster: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.flow !== 'lead') return err({ kind: 'not_lead_flow', workspaceId })
  if (workspace.leadRoster.length > 0) {
    return err({ kind: 'lead_setting_invalid', field: 'roster', rule: `the roster already names ${String(workspace.leadRoster.length)} person(s); it is filled from the conversation only while it is empty` })
  }
  const personas = await proposedPersonas(workspaceId)
  if (personas === null) return err({ kind: 'lead_setting_invalid', field: 'roster', rule: 'no conversation with a project card created this project, so nobody was proposed for it' })
  if (personas.length === 0) return err({ kind: 'lead_setting_invalid', field: 'roster', rule: 'the conversation that created this project proposed nobody' })
  return fillLeadRoster(workspaceId, personas)
}
