import { loadSupervisorWorld, syncCapabilityTaxonomy } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildOrganization, type OrganizationView } from '../../src/server/organization'
import { GET as organizationGET } from '../../src/app/api/w/[workspaceId]/organization/route'
import { seedWorkspace, truncateAll } from './projectFixture'

/** The one `next/headers` mock the route case needs (`workforce-catalog.test.ts`'s idiom). Inert
 *  without `SLAVEOFAI_SESSION_SECRET`: `requirePrincipal` short-circuits before `cookies()`. */
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (): undefined => undefined }),
}))

/**
 * What `loadSupervisorWorld` throws instead of loading, when a case asks it to -- `null` means "do
 * the real thing", which is every case but the two TOCTOU ones.
 *
 * A mutable holder rather than `mockImplementation`, because `vi.mock` is hoisted above every
 * `const` in this file and the factory may not close over one that is not yet initialised.
 */
const loaderThrows: { value: unknown } = { value: null }

vi.mock('@slave-of-ai/control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slave-of-ai/control')>()
  return {
    ...actual,
    loadSupervisorWorld: async (
      ...args: Parameters<typeof actual.loadSupervisorWorld>
    ): ReturnType<typeof actual.loadSupervisorWorld> => {
      if (loaderThrows.value !== null) throw loaderThrows.value
      return actual.loadSupervisorWorld(...args)
    },
  }
})

/**
 * `buildOrganization` (M47 R6) against a real board: three workers who each got here a different
 * way, three ready tasks asking for three capabilities -- one covered, one a gap somebody can
 * fill, one nobody anywhere provides -- and one pending proposal about the gap.
 *
 * The taxonomy is a SEEDED reference table, not a fixture: `truncateAll` does not touch
 * `Capability`, and `syncCapabilityTaxonomy()` puts back anything a neighbouring suite edited, so
 * `Application security` and `iOS` are the labels this file asserts on.
 */
describe('buildOrganization', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await truncateAll()
    await syncCapabilityTaxonomy()
    const fixture = await seedWorkspace({ role: 'engineering' })
    workspaceId = fixture.workspaceId

    const platform = await prisma.slaveTemplate.create({
      data: { name: 'Gate Platform Builder', role: 'backend', capabilityKeys: ['backend.api-design'] },
    })
    const security = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    await prisma.collaborationHint.create({
      data: {
        templateId: security.id,
        text: 'Consult the Gate Platform Builder before changing an endpoint.',
        targetTemplateId: platform.id,
        capability: 'backend.api-design',
      },
    })

    // Alex came off a company roster: `seedWorkspace` already made the worker, so this attaches
    // the roster row it was materialised from and the company it belongs to.
    const company = await prisma.company.create({ data: { name: 'M47 Co' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Platform' } })
    const rosterRow = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: platform.id, name: 'Alex' },
    })
    await prisma.workspace.update({ where: { id: workspaceId }, data: { companyId: company.id } })
    // `lifecycle: 'permanent'` beside the roster link (M50 R1): a worker materialised from a
    // company roster IS somebody the organisation has, which is exactly what the migration's one
    // data statement writes for every pre-M50 roster-linked worker.
    await prisma.slave.update({
      where: { id: fixture.slaveId },
      data: { companySlaveId: rosterRow.id, lifecycle: 'permanent' },
    })

    // Rae predates all of this: no rationale, no roster row, and the `backend` role that makes
    // `backend.api-design` a covered capability rather than a gap.
    await prisma.slave.create({
      data: {
        teamId: fixture.teamId,
        name: 'Rae',
        role: 'backend',
        // `data` and `qa` are here so the settled tasks below ask for something Rae genuinely
        // provides AND may be dispatched for -- the case is about the task's STATUS, not about a
        // gap dressed up as one.
        runtimeRoles: ['backend', 'data', 'qa'],
        capabilities: ['backend.api-design', 'data.pipelines', 'qa.test-automation'],
      },
    })
    // Hired for this project, and PROVIDES the missing capability without holding its role -- the
    // shape `formTeam` turns into an `assign_capability` proposal.
    await prisma.slave.create({
      data: {
        teamId: fixture.teamId,
        name: 'Security Reviewer',
        role: 'security',
        runtimeRoles: ['reviewer'],
        capabilities: ['security.application'],
        hiredFromTemplateId: security.id,
        selectionRationale: 'Hired for security.application because the board needs it',
      },
    })
    // A temporary specialist whose engagement is over (M50 R3/D7). The name sorts FIRST of the
    // four, so the row landing LAST is a statement about the sort and not about the alphabet.
    await prisma.slave.create({
      data: {
        teamId: fixture.teamId,
        name: 'Aaron',
        role: 'security',
        // Nothing to dispatch and nothing to cover: this row is about the SORT and the released
        // marker, and a capability on it would quietly move the coverage the cases below pin.
        runtimeRoles: [],
        capabilities: [],
        lifecycle: 'ephemeral',
        releasedAt: new Date('2026-09-12T10:00:00.000Z'),
        releaseReason: 'the engagement is over',
        selectionRationale: 'Brought in for the security pass',
      },
    })

    for (const [title, capability, status] of [
      ['Ship the checkout API', 'backend.api-design', 'ready'],
      ['Review the checkout API', 'security.application', 'ready'],
      ['Ship the phone app', 'mobile.ios', 'ready'],
      // Two SETTLED tasks (fix round 1, Critical): a board's gaps are what its ready and blocked
      // work asks for, and neither of these is either.
      ['Load the nightly warehouse', 'data.pipelines', 'done'],
      ['Automate the smoke suite', 'qa.test-automation', 'running'],
    ] as const) {
      await prisma.task.create({
        data: {
          workspaceId,
          title,
          description: 'seeded by the M47 organization fixture',
          status,
          requiredRole: 'dev',
          requiredCapabilities: [capability],
          maxAttempts: 3,
        },
      })
    }

    await prisma.supervisorDecision.create({
      data: {
        workspaceId,
        situationKind: 'capability_unstaffed',
        subjectId: 'security.application',
        situation: {
          kind: 'capability_unstaffed',
          subjectId: 'security.application',
          summary: 'Nobody on this project can be dispatched for Application security.',
          facts: { capability: 'security.application', role: 'security', readyTasks: 1 },
        },
        candidates: [],
        chosenIndex: 0,
        action: {
          kind: 'hire_from_catalog',
          templateId: security.id,
          capability: 'security.application',
          capabilityLabel: 'Application security',
          name: 'Security Reviewer',
          rationale: 'Security Reviewer provides Application security and nobody here does.',
          temporary: false,
        },
        rationale: 'Security Reviewer provides Application security and nobody here does.',
        tier: 'proposed',
        status: 'pending',
        decidedBy: 'rules',
        modelCalled: false,
      },
    })
  })

  afterEach(() => {
    loaderThrows.value = null
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('says who is here, how they got here and what they provide', async () => {
    const view = await buildOrganization(workspaceId)
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.workers.map((worker) => [worker.name, worker.lifecycle, worker.why])).toEqual([
      ['Alex', 'permanent', 'Assigned from M47 Co'],
      ['Rae', 'project', 'Seeded'],
      ['Security Reviewer', 'project', 'Hired for security.application because the board needs it'],
      // Released LAST, though 'Aaron' sorts first by name (M50 D7): the roster is partitioned, and
      // nobody is ever removed from it.
      ['Aaron', 'ephemeral', 'Brought in for the security pass'],
    ])
    expect(view.workers[2]?.capabilities).toEqual([{ key: 'security.application', label: 'Application security' }])
  })

  // M50 R3: the engagement ended, and the row says when, in the sentence it ended with.
  it('carries the date and the reason a released worker was released', async () => {
    const view = await buildOrganization(workspaceId)
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.workers.filter((worker) => worker.released !== null).map((worker) => worker.name)).toEqual(['Aaron'])
    expect(view.workers.at(-1)?.released).toEqual({
      at: '2026-09-12T10:00:00.000Z',
      reason: 'the engagement is over',
    })
  })

  it('shows what the board needs, the proposals waiting on a person, and what nobody can do', async () => {
    const view = await buildOrganization(workspaceId)
    // The `not.toBeNull()` is the assertion; the narrowing return below is only TypeScript's
    // (final review, Minor 9). Without it a builder that started returning null would make every
    // one of these cases pass by asserting nothing at all.
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.needs.map((need) => need.capability)).toEqual(['security.application'])
    expect(view.needs[0]?.label).toBe('Application security')
    expect(view.needs[0]?.readyTasks).toBe(1)
    expect(view.needs[0]?.decisions.map((decision) => decision.action.kind)).toEqual(['hire_from_catalog'])
    expect(view.covered.map((one) => one.capability)).toEqual(['backend.api-design'])
    expect(view.unfillable.map((one) => one.capability)).toEqual(['mobile.ios'])
    expect(view.unfillable.map((one) => one.label)).toEqual(['iOS'])
  })

  // M53 R9: the staffing decision, read where it is acted on. The setter is resolved to a USERNAME
  // at this boundary in ONE batched lookup (M52 erratum E18) -- the column holds a `User.id`, and a
  // page that printed it would be printing a key at a person.
  it('carries each capability staffing decision, with the setter as a username and the id beside it', async () => {
    // `truncateAll` does not name `User` (accounts outlive a project fixture), so the username is
    // this file's own rather than a bare `ada` another suite may already hold.
    const user = await prisma.user.upsert({
      where: { username: 'm53-organization-ada' },
      create: { username: 'm53-organization-ada', passwordHash: 'x' },
      update: {},
    })
    const template = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Security Reviewer' } })
    const { setStaffingPreference } = await import('@slave-of-ai/control')
    const written = await setStaffingPreference(
      workspaceId,
      { capability: 'security.application', templateId: template.id, model: 'opus' },
      // `Principal` in control is a `userId` and nothing else -- the NAME is each surface's own
      // resolution, which is the whole of M52 erratum E18.
      { userId: user.id },
    )
    expect(written.ok).toBe(true)

    const view = await buildOrganization(workspaceId)
    expect(view).not.toBeNull()
    if (view === null) return
    const need = view.needs.find((one) => one.capability === 'security.application')
    expect(need?.preference?.templateName).toBe('Security Reviewer')
    expect(need?.preference?.model).toBe('opus')
    expect(need?.preference?.setBy).toBe('m53-organization-ada')
    expect(need?.preference?.setById).toBe(user.id)
    // Nothing was asked for on the covered capability, and that is a null rather than a blank row.
    expect(view.covered.find((one) => one.capability === 'backend.api-design')?.preference).toBeNull()
    // The pick list is read once for the page and holds every template, so a person can ask for a
    // specialist who is not on this project yet -- which is the case a preference is for.
    expect(view.templates.map((one) => one.name)).toEqual(['Gate Platform Builder', 'Security Reviewer'])
  })

  it('says a setter is no longer on record rather than printing their id', async () => {
    await prisma.staffingPreference.create({
      data: { workspaceId, capability: 'security.application', model: 'opus', setBy: 'u-gone' },
    })

    const view = await buildOrganization(workspaceId)
    expect(view).not.toBeNull()
    if (view === null) return
    const preference = view.needs.find((one) => one.capability === 'security.application')?.preference
    // `setBy` null with `setById` set is "the account was deleted since"; both null would be "the
    // decision named nobody at all", and the page says the two apart.
    expect(preference?.setBy).toBeNull()
    expect(preference?.setById).toBe('u-gone')
  })

  it('carries the advisory edges, and never anything that dispatches', async () => {
    const view = await buildOrganization(workspaceId)
    // The `not.toBeNull()` is the assertion; the narrowing return below is only TypeScript's
    // (final review, Minor 9). Without it a builder that started returning null would make every
    // one of these cases pass by asserting nothing at all.
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.hints).toEqual([
      {
        slaveId: expect.any(String),
        text: 'Consult the Gate Platform Builder before changing an endpoint.',
        targetTemplateName: 'Gate Platform Builder',
        capability: 'backend.api-design',
        // The words beside the key (fix round 1, Important): the caption prints this and keeps the
        // key one attribute away, like every other capability on this page.
        capabilityLabel: 'API design',
      },
    ])
  })

  // Fix round 1, Critical. The needs list is the PLAN's gaps and nothing else: a second reading of
  // "what is missing" -- one over every task the board has ever held -- reported a done task's
  // capability as unstaffed while the worker holding its role sat two rows above it.
  it('never calls a settled task\'s capability a gap, however the roster stands', async () => {
    const view = await buildOrganization(workspaceId)
    // The `not.toBeNull()` is the assertion; the narrowing return below is only TypeScript's
    // (final review, Minor 9). Without it a builder that started returning null would make every
    // one of these cases pass by asserting nothing at all.
    expect(view).not.toBeNull()
    if (view === null) return
    const named = [
      ...view.needs.map((need) => need.capability),
      ...view.covered.map((one) => one.capability),
      ...view.unfillable.map((one) => one.capability),
    ]
    expect(named).not.toContain('data.pipelines')
    expect(named).not.toContain('qa.test-automation')
    expect(view.covered.map((one) => one.capability)).toEqual(['backend.api-design'])
  })

  /**
   * FINAL REVIEW, IMPORTANT 2. Three readings of "what is missing" disagreed: `observe` said
   * `ready && dependenciesDone`, `teamPlanOf` said `ready || blocked`, and this count said `ready`
   * alone. So a BLOCKED task -- one waiting on a guardrail or a human, which staffing does not
   * unstick -- produced a proposal no situation would ever raise, and a need row a person could not
   * act on; and a ready task whose dependency was not integrated was counted here and not there.
   */
  it('is not a staffing need while the work is blocked, and counts only what the situation counted', async () => {
    const reviewer = await prisma.slave.findFirstOrThrow({ where: { name: 'Security Reviewer', team: { workspaceId } } })
    // A second capability the same worker provides and nobody holds the role for: under the old
    // `ready || blocked` reading the blocked task below made it a gap on this page.
    await prisma.slave.update({
      where: { id: reviewer.id },
      data: { capabilities: ['security.application', 'docs.technical-writing'] },
    })
    const blocked = await prisma.task.create({
      data: {
        workspaceId,
        title: 'Write the integration guide',
        description: 'seeded by the M47 organization fixture',
        status: 'blocked',
        requiredRole: 'dev',
        requiredCapabilities: ['docs.technical-writing'],
        maxAttempts: 3,
      },
    })
    // A second ready task for the capability that IS a need, waiting on that blocked one: ready,
    // but not startable, so neither the situation nor this count may include it.
    const waiting = await prisma.task.create({
      data: {
        workspaceId,
        title: 'Re-review the checkout API',
        description: 'seeded by the M47 organization fixture',
        status: 'ready',
        requiredRole: 'dev',
        requiredCapabilities: ['security.application'],
        maxAttempts: 3,
      },
    })
    await prisma.taskDependency.create({ data: { taskId: waiting.id, dependsOnTaskId: blocked.id } })

    const view = await buildOrganization(workspaceId)
    expect(view).not.toBeNull()
    if (view === null) return
    const named = [
      ...view.needs.map((need) => need.capability),
      ...view.covered.map((one) => one.capability),
      ...view.unfillable.map((one) => one.capability),
    ]
    expect(named).not.toContain('docs.technical-writing')
    // The one ready, startable task -- not the one waiting on a dependency that has not been
    // integrated, and this is the number the stored situation's own `readyTasks` fact carries.
    const need = view.needs.find((one) => one.capability === 'security.application')
    expect(need?.readyTasks).toBe(1)
    expect(need?.decisions[0]?.situation.facts.readyTasks).toBe(need?.readyTasks)
  })

  // Fix round 1, minor 4. A proposal whose capability somebody has since been given a role for is
  // still waiting on a human somewhere; this page owes them the fact that it is not showing it.
  it('counts the pending staffing proposals no need row can show', async () => {
    const before = await buildOrganization(workspaceId)
    expect(before?.pendingElsewhere).toBe(0)

    await prisma.supervisorDecision.create({
      data: {
        workspaceId,
        situationKind: 'capability_unstaffed',
        // Covered by Rae, so no need row carries it -- and the proposal is still pending.
        subjectId: 'backend.api-design',
        situation: {
          kind: 'capability_unstaffed',
          subjectId: 'backend.api-design',
          summary: 'Nobody on this project can be dispatched for API design.',
          facts: {},
        },
        candidates: [],
        chosenIndex: 0,
        action: { kind: 'escalate_to_human', summary: 'nobody provides API design' },
        rationale: 'stale by the time a human got to it',
        tier: 'proposed',
        status: 'pending',
        decidedBy: 'rules',
        modelCalled: false,
      },
    })

    const after = await buildOrganization(workspaceId)
    expect(after).not.toBeNull()
    expect(after?.pendingElsewhere).toBe(1)
    expect(after?.needs.map((need) => need.capability)).toEqual(['security.application'])
  })

  // Fix round 1, minor 5. `listOrganization` says the project is there and the world loader opens
  // its own transaction a moment later: a project deleted in between is a 404, not a 500.
  it('is null when the project is deleted between the check and the world load', async () => {
    loaderThrows.value = Object.assign(new Error('record not found'), { code: 'P2025' })
    expect(await buildOrganization(workspaceId)).toBeNull()
  })

  // The fact the mock above STANDS IN FOR, asserted against the real loader (final review, Minor
  // 9): `isRecordNotFound` reads Prisma's `P2025` off the error it actually throws, and a mock
  // that made that code up would keep passing after the loader stopped throwing it.
  it('is really P2025 the loader throws for a project that is not there', async () => {
    // `loaderThrows` is null here (the `beforeEach` resets it), so the wrapper above calls straight
    // through to the real loader -- no second module instance, and no second Prisma client.
    loaderThrows.value = null
    await expect(loadSupervisorWorld('nope', new Date())).rejects.toMatchObject({ code: 'P2025' })
  })

  it('still throws when the world load fails for any other reason', async () => {
    loaderThrows.value = new Error('the database went away')
    await expect(buildOrganization(workspaceId)).rejects.toThrow('the database went away')
  })

  it('is null for a workspace that is not there', async () => {
    expect(await buildOrganization('nope')).toBeNull()
  })

  it('answers the refetch route the page re-reads itself with, and 404s for a project that is not there', async () => {
    const answer = await organizationGET(new Request('http://test/organization'), {
      params: Promise.resolve({ workspaceId }),
    })
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as OrganizationView
    expect(body.workers.map((worker) => worker.name)).toEqual(['Alex', 'Rae', 'Security Reviewer', 'Aaron'])
    expect(body.needs.map((need) => need.capability)).toEqual(['security.application'])

    const missing = await organizationGET(new Request('http://test/organization'), {
      params: Promise.resolve({ workspaceId: 'nope' }),
    })
    expect(missing.status).toBe(404)
  })
})
