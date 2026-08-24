import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import type { ControlRefusal } from './refusal.js'

/**
 * `true` for Prisma's unique-constraint violation (P2002), the error every `create` below can
 * throw when it collides with a `@unique`/`@@unique` index. Checked by shape rather than
 * `instanceof PrismaClientKnownRequestError` -- the class is a runtime value the generated client
 * does not currently re-export from `@ai-team-os/db/client` -- and caught rather than
 * pre-queried: a pre-query-then-insert has a race between the two steps that the DB constraint
 * itself cannot have.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

/**
 * Adds a reusable agent template to the catalog (M10 §4) -- the definition `addCompanyAgent`
 * below instantiates onto a company's roster. Templates are append-only (Decision 9): there is no
 * update or delete here, only creation.
 */
export async function createTemplate(
  name: string,
  role: string,
  options?: { readonly description?: string; readonly defaultModel?: string },
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '' || role.trim() === '') return err({ kind: 'invalid_name' })

  try {
    const template = await prisma.agentTemplate.create({
      data: {
        name,
        role,
        ...(options?.description !== undefined ? { description: options.description } : {}),
        ...(options?.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
      },
    })
    return ok({ id: template.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/** Adds a company -- a persistent roster (M10 §4) -- to the catalog. */
export async function createCompany(name: string): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  try {
    const company = await prisma.company.create({ data: { name } })
    return ok({ id: company.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/** Adds a team to a company's roster. Team names are unique per company, not globally. */
export async function addCompanyTeam(
  companyId: string,
  name: string,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } })
  if (company === null) return err({ kind: 'company_not_found', companyId })

  try {
    const team = await prisma.companyTeam.create({ data: { companyId, name } })
    return ok({ id: team.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/**
 * Adds a roster member -- a durable identity such as "Atlas" -- to a company team, instantiated
 * from a template. Agent names are unique per team, not globally: the same name in two different
 * teams (even in the same company) is unrelated identities and is allowed.
 */
export async function addCompanyAgent(
  companyTeamId: string,
  templateId: string,
  name: string,
  options?: { readonly model?: string },
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  const team = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { id: true } })
  if (team === null) return err({ kind: 'company_team_not_found', companyTeamId })

  const template = await prisma.agentTemplate.findUnique({ where: { id: templateId }, select: { id: true } })
  if (template === null) return err({ kind: 'template_not_found', templateId })

  try {
    const agent = await prisma.companyAgent.create({
      data: {
        companyTeamId,
        templateId,
        name,
        ...(options?.model !== undefined ? { model: options.model } : {}),
      },
    })
    return ok({ id: agent.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}
