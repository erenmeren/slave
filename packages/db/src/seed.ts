import { CHECKOUT_PLATFORM_COMPANY_NAME, CHECKOUT_PLATFORM_ROSTER, CHECKOUT_PLATFORM_TEAMS, checkoutPlatformTemplateName } from './checkout-platform.js'
import { prisma } from './client.js'
import { TASK_STATUSES } from './enums.js'
import { SEED_WORKSPACE_ID } from './seed-workspace-id.js'

export { SEED_WORKSPACE_ID }

/**
 * The reusable slave templates (M10 §4) a company's roster instantiates from. `defaultModel` is
 * `null` for every one -- a model choice is an operator decision (set later via `set-model` /
 * `assignCompany`'s roster override), never a seed opinion. Java Developer and Backend Developer
 * deliberately share a `role`: the canonical example of two templates being distinct catalog
 * entries even when their underlying worker role is the same.
 */
const TEMPLATES: readonly { name: string; role: string }[] = [
  { name: 'Engineering Manager', role: 'manager' },
  { name: 'Backend Developer', role: 'backend' },
  { name: 'Frontend Developer', role: 'frontend' },
  { name: 'QA Reviewer', role: 'reviewer' },
  { name: 'Java Developer', role: 'backend' },
]

const COMPANY_NAME = 'Atlas Software'
const COMPANY_TEAM_NAME = 'Engineering'

export const DEMO_TRADING_COMPANY_NAME = 'Demo Trading Co.'
const TRADE_ROSTER: readonly (readonly [string, string])[] = [['Sales', 'Sonia'], ['Purchasing', 'Pete'], ['Operations', 'Olga'], ['Finance', 'Fin']]

/** Atlas Software's Engineering roster -- mirrors today's seeded crew, one member per template. */
const ROSTER: readonly { name: string; template: string }[] = [
  { name: 'Atlas', template: 'Engineering Manager' },
  { name: 'Alex', template: 'Backend Developer' },
  { name: 'Emma', template: 'Frontend Developer' },
  { name: 'Riley', template: 'QA Reviewer' },
]

/**
 * Truncate-and-reseed rather than upsert. Upserts have to guess which rows correspond, and a
 * seed that guesses drifts from the schema silently. This one is idempotent by construction.
 */
export async function seed(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "SimulationModelUsage", "SimulationJournalEntry", "SimulationRun", "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "SlaveSkill", "Skill", "SkillProvider", "SlavePermission", "ProviderConfiguration", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )

  const workspace = await prisma.workspace.create({
    data: {
      id: SEED_WORKSPACE_ID,
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout-platform',
      verifyCommands: ['npm run build', 'npm test'],
      setupCommands: ['npm ci'],
      // Deliberately not the schema default of 3. Every seeded task copies this value below —
      // if it matched the default, that copy would be indistinguishable from a hardcoded
      // literal, and the link between Workspace.maxAttempts and Task.maxAttempts (the thing
      // M1's final review found unlinked) would go untested. Do not "tidy" this back to 3.
      maxAttempts: 5,
    },
  })

  // Without a ProviderConfiguration row, `workspaceDefaultProvider` (M12 Task 8) returns null,
  // `resolveRuntime` refuses every dispatch with `invalid_provider`, and the seeded workspace
  // cannot run a single task -- do not drop this when editing seed data.
  await prisma.providerConfiguration.create({
    data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} },
  })

  for (const team of CHECKOUT_PLATFORM_TEAMS) {
    await prisma.team.create({ data: { workspaceId: workspace.id, name: team } })
  }

  const teamsByName = new Map(
    (await prisma.team.findMany()).map((team) => [team.name, team.id] as const),
  )

  for (const member of CHECKOUT_PLATFORM_ROSTER) {
    const teamId = teamsByName.get(member.departmentName)
    if (teamId === undefined) {
      throw new Error(`seed is inconsistent: no team named ${member.departmentName}`)
    }
    // `runtimeRoles: [member.role]` (M37 t1 fix round 1): this is the one non-test
    // `slave.create` in the repo that predates `runtimeRoles`, and it would otherwise rely on
    // the column's `@default([])` -- fine today (nothing reads `runtimeRoles` yet), but every
    // legacy-workspace seed slave would become permanently undispatchable the moment Task 3
    // wires the scheduler onto this column instead of `role`. Mirrors the same placeholder
    // `packages/control/src/org.ts` `assignCompanyTx` writes.
    await prisma.slave.create({
      data: { teamId, name: member.slaveName, role: member.role, runtimeRoles: [member.role] },
    })
  }

  // The reusable template catalog and Atlas Software's roster (M10 §4-5) -- written directly with
  // prisma, the same style as the legacy workspace above, not through the `packages/control`
  // verbs. The legacy workspace's hand-made teams/slaves above are left untouched and the
  // workspace is never assigned to Atlas Software (spec Decision 7 -- legacy stays legacy;
  // assignment is the operator's first act).
  for (const template of TEMPLATES) {
    await prisma.slaveTemplate.create({ data: { name: template.name, role: template.role, defaultModel: null } })
  }

  const templatesByName = new Map(
    (await prisma.slaveTemplate.findMany()).map((template) => [template.name, template.id] as const),
  )

  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  const companyTeam = await prisma.companyTeam.create({
    data: { companyId: company.id, name: COMPANY_TEAM_NAME },
  })

  for (const member of ROSTER) {
    const templateId = templatesByName.get(member.template)
    if (templateId === undefined) {
      throw new Error(`seed is inconsistent: no template named ${member.template}`)
    }
    await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId, name: member.name },
    })
  }

  // M29: a second, non-software company so the Simulations page has a roster to freeze. Four
  // departments named for the trade sector's four roles, one catalog slave each, from one
  // generic template. Synthetic like everything else here; never assigned to a workspace.
  const tradeTemplate = await prisma.slaveTemplate.create({ data: { name: 'Trade Clerk', role: 'clerk', defaultModel: null } })
  const trading = await prisma.company.create({ data: { name: DEMO_TRADING_COMPANY_NAME } })
  for (const [department, slave] of TRADE_ROSTER) {
    const team = await prisma.companyTeam.create({ data: { companyId: trading.id, name: department } })
    await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId: tradeTemplate.id, name: slave } })
  }

  // M31b final fix wave: a catalog company the SOFTWARE sector actually fits. Neither of the two
  // companies above does -- Atlas Software is a single Engineering department (no Product, no
  // Management), and the trade demo's four clerks have no Engineering at all -- so before this
  // the drawer's software list was empty on freshly-seeded data and the README had to tell an
  // operator to build a company by hand. This is the legacy workspace's own crew as a catalog
  // company: the same departments, the same roles, so `rosterOf` reads exactly the roster
  // `packages/simulation/test/software/roster.ts` pins its figures against. One template per
  // distinct role, because `rosterOf` takes a catalog slave's role off its TEMPLATE.
  const checkoutTemplateIds = new Map<string, string>()
  for (const role of new Set(CHECKOUT_PLATFORM_ROSTER.map((member) => member.role))) {
    const template = await prisma.slaveTemplate.create({ data: { name: checkoutPlatformTemplateName(role), role, defaultModel: null } })
    checkoutTemplateIds.set(role, template.id)
  }
  const checkout = await prisma.company.create({ data: { name: CHECKOUT_PLATFORM_COMPANY_NAME } })
  for (const department of CHECKOUT_PLATFORM_TEAMS) {
    const members = CHECKOUT_PLATFORM_ROSTER.filter((member) => member.departmentName === department)
    if (members.length === 0) continue
    const team = await prisma.companyTeam.create({ data: { companyId: checkout.id, name: department } })
    for (const member of members) {
      const templateId = checkoutTemplateIds.get(member.role)
      if (templateId === undefined) {
        throw new Error(`seed is inconsistent: no template for role ${member.role}`)
      }
      await prisma.companySlave.create({ data: { companyTeamId: team.id, templateId, name: member.slaveName } })
    }
  }

  // One task per status, so every state has a real example on screen when M4 arrives.
  // maxAttempts is copied from the workspace guardrail configuration — the only correct source.
  // Deliberately NO `requiredRole` on any seeded task: `decide()` cannot match a roleless task to
  // a slave, so a daemon pointed at freshly-seeded data starts nothing and spends nothing -- the
  // tick's `skippedNoRole: 12` on this workspace is that invariant showing, not a bug (M15 spec
  // §3 B5). The seed demonstrates the UI's states; it must never be dispatchable demo data,
  // because this workspace carries a live ProviderConfiguration and real runs cost real money.
  for (const status of TASK_STATUSES) {
    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `Checkout task in ${status}`,
        description: `Demonstrates the ${status} state.`,
        status,
        maxAttempts: workspace.maxAttempts,
      },
    })
  }
}

if (process.argv[1]?.endsWith('seed.js') === true) {
  await seed()
  await prisma.$disconnect()
}
