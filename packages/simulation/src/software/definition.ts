import { z } from 'zod'
import { initialEngineState, type EngineDefinition, type EngineState } from '../core/engine.js'
import type { RoleDefinition, ScheduleRequest } from '../core/sector.js'
import type { SoftwareEvent } from './events.js'
import { areaSchema, expertiseSchema, initialSoftwareState, type Expertise, type SoftwareState } from './state.js'

export const SOFTWARE_ROLE_NAMES = ['product', 'lead', 'reviewer'] as const
export type SoftwareRoleName = (typeof SOFTWARE_ROLE_NAMES)[number]
export type SoftwarePolicy = 'A' | 'B'

/** What `assignRoles` throws verbatim, and the plugin's `rosterRequirement` (design §3.2). */
export const SOFTWARE_ROSTER_REQUIREMENT = 'the software sector needs a Product slave, a Management slave, a QA or reviewer slave and at least two more Engineering slaves'

/** The two policies, frozen into the definition at creation and read from there by `rules.ts` and
 *  by the model through the state (design §3.4). A is fast: one review a day, only incidents get
 *  reviewed, take whoever is free. B is careful: two reviews a day, everything gets reviewed, hold
 *  a task up to two days for an engineer who actually knows the area. */
export const POLICY_SETTINGS: Readonly<Record<SoftwarePolicy, { readonly reviewCapacityPerDay: number; readonly reviewEverything: boolean; readonly matchWaitDays: number }>> = {
  A: { reviewCapacityPerDay: 1, reviewEverything: false, matchWaitDays: 0 },
  B: { reviewCapacityPerDay: 2, reviewEverything: true, matchWaitDays: 2 },
}

const roleSchema = z.object({ name: z.string(), purpose: z.string(), observes: z.array(z.string()), allowedActions: z.array(z.string()), constraints: z.record(z.number()), slaveName: z.string() })
const engineerSpecSchema = z.object({ id: z.string(), expertise: expertiseSchema })
const scenarioRequestSchema = z.object({ day: z.number().int().nonnegative(), area: areaSchema, sizeDays: z.number().int().min(1).max(5), dueInDays: z.number().int().positive() })

export const softwareSimulationDefinitionSchema = z.object({
  sector: z.literal('software'),
  currency: z.string().min(3).max(3),
  policy: z.enum(['A', 'B']),
  seed: z.number().int(),
  horizonDays: z.number().int().positive(),
  limits: z.object({ maxSteps: z.number().int().positive(), maxDecisionsPerStep: z.number().int().positive(), maxJournalEntries: z.number().int().positive() }),
  roles: z.array(roleSchema),
  roleOrder: z.array(z.string()),
  engineers: z.array(engineerSpecSchema),
  scenario: z.object({ requests: z.array(scenarioRequestSchema) }),
  reviewCapacityPerDay: z.number().int().nonnegative(),
  reviewEverything: z.boolean(),
  matchWaitDays: z.number().int().nonnegative(),
  /** As trade (M31a): which roles decide with a model. `.default([])` keeps an older row parsing. */
  llmRoles: z.array(z.string()).default([]),
})
export type SoftwareSimulationDefinition = z.infer<typeof softwareSimulationDefinitionSchema> & EngineDefinition
export type SoftwareEngineerSpec = z.infer<typeof engineerSpecSchema>
export type SoftwareRosterEntry = { readonly slaveName: string; readonly departmentName: string; readonly role?: string }

/** The synthetic demo (design §3.5): twelve feature requests across thirty days, three areas, no
 *  injected incidents — every incident in a run is one the model's own skipped review produced. */
export const DEMO_SCENARIO = {
  currency: 'USD',
  horizonDays: 30,
  limits: { maxSteps: 365, maxDecisionsPerStep: 8, maxJournalEntries: 20_000 },
  requests: [
    { day: 1, area: 'backend', sizeDays: 3, dueInDays: 10 },
    { day: 1, area: 'frontend', sizeDays: 2, dueInDays: 8 },
    { day: 2, area: 'devops', sizeDays: 1, dueInDays: 5 },
    { day: 3, area: 'backend', sizeDays: 4, dueInDays: 14 },
    { day: 4, area: 'frontend', sizeDays: 3, dueInDays: 12 },
    { day: 6, area: 'backend', sizeDays: 2, dueInDays: 8 },
    { day: 8, area: 'devops', sizeDays: 3, dueInDays: 12 },
    { day: 9, area: 'frontend', sizeDays: 1, dueInDays: 5 },
    { day: 11, area: 'backend', sizeDays: 5, dueInDays: 18 },
    { day: 13, area: 'frontend', sizeDays: 2, dueInDays: 8 },
    { day: 15, area: 'devops', sizeDays: 2, dueInDays: 9 },
    { day: 18, area: 'backend', sizeDays: 3, dueInDays: 12 },
  ],
} as const

const OBSERVES: Readonly<Record<SoftwareRoleName, readonly string[]>> = {
  product: ['requestedTasks', 'queueLength'],
  lead: ['queue', 'engineers', 'matchWaitDays'],
  reviewer: ['inReviewTasks', 'reviewCapacityPerDay', 'reviewedToday'],
}
const ALLOWED: Readonly<Record<SoftwareRoleName, readonly string[]>> = {
  product: ['accept_request', 'note'],
  lead: ['assign_task', 'note'],
  reviewer: ['review_task', 'note'],
}
const PURPOSE: Readonly<Record<SoftwareRoleName, string>> = {
  product: 'accepts requests into the queue',
  lead: 'assigns queued work to engineers',
  reviewer: 'reviews finished work within the day\'s capacity',
}
const CONSTRAINTS: Readonly<Record<SoftwareRoleName, Readonly<Record<string, number>>>> = {
  product: {},
  // Four engineers is the demo's whole capacity, so this cap is the honest one: past it every
  // further assignment in a day would be rejected `engineer_busy` anyway.
  lead: { maxAssignmentsPerStep: 4 },
  reviewer: {},
}

const EXPERTISE_BY_ROLE: Readonly<Record<string, Expertise>> = { backend: 'backend', frontend: 'frontend', devops: 'devops' }

function expertiseFor(role: string | undefined): Expertise {
  return EXPERTISE_BY_ROLE[(role ?? '').toLowerCase()] ?? 'general'
}

const inDepartment = (entry: SoftwareRosterEntry, department: string): boolean => entry.departmentName.toLowerCase() === department
const hasRole = (entry: SoftwareRosterEntry, role: string): boolean => (entry.role ?? '').toLowerCase() === role

/** Picks the three decision roles and the engineer pool out of a frozen roster (design §3.2).
 *  `reviewer` prefers the catalog's dedicated `reviewer` role over `QA`, so on the Checkout
 *  Platform roster Riley reviews and Maya stays an engineer (with `general` expertise). */
function readRoster(roster: readonly SoftwareRosterEntry[]): { readonly roles: RoleDefinition[]; readonly engineers: SoftwareEngineerSpec[] } | null {
  const product = roster.find((r) => inDepartment(r, 'product'))
  const lead = roster.find((r) => inDepartment(r, 'management'))
  const engineering = roster.filter((r) => inDepartment(r, 'engineering'))
  const reviewer = engineering.find((r) => hasRole(r, 'reviewer')) ?? engineering.find((r) => hasRole(r, 'qa'))
  if (product === undefined || lead === undefined || reviewer === undefined) return null
  const engineers = engineering.filter((r) => r.slaveName !== reviewer.slaveName).map((r) => ({ id: r.slaveName, expertise: expertiseFor(r.role) }))
  if (engineers.length < 2) return null
  const slaveFor: Readonly<Record<SoftwareRoleName, string>> = { product: product.slaveName, lead: lead.slaveName, reviewer: reviewer.slaveName }
  const roles = SOFTWARE_ROLE_NAMES.map((name) => ({ name, purpose: PURPOSE[name], observes: [...OBSERVES[name]], allowedActions: [...ALLOWED[name]], constraints: { ...CONSTRAINTS[name] }, slaveName: slaveFor[name] }))
  return { roles, engineers }
}

export function rosterFits(roster: readonly SoftwareRosterEntry[]): boolean {
  return readRoster(roster) !== null
}

export function assignRoles(roster: readonly SoftwareRosterEntry[]): { readonly roles: RoleDefinition[]; readonly engineers: SoftwareEngineerSpec[] } {
  const read = readRoster(roster)
  if (read === null) throw new Error(SOFTWARE_ROSTER_REQUIREMENT)
  return read
}

function build(input: { readonly policy: SoftwarePolicy; readonly seed: number; readonly currency: string; readonly roles: readonly RoleDefinition[]; readonly engineers: readonly SoftwareEngineerSpec[]; readonly llmRoles: readonly string[]; readonly requests: readonly { day: number; area: string; sizeDays: number; dueInDays: number }[]; readonly horizonDays: number; readonly limits: typeof DEMO_SCENARIO.limits }): SoftwareSimulationDefinition {
  return softwareSimulationDefinitionSchema.parse({
    sector: 'software', currency: input.currency, policy: input.policy, seed: input.seed,
    horizonDays: input.horizonDays, limits: input.limits, roles: input.roles, roleOrder: [...SOFTWARE_ROLE_NAMES],
    engineers: input.engineers, scenario: { requests: input.requests }, ...POLICY_SETTINGS[input.policy], llmRoles: input.llmRoles,
  }) as SoftwareSimulationDefinition
}

export function demoDefinition(input: { readonly policy: SoftwarePolicy; readonly seed: number; readonly roster: readonly SoftwareRosterEntry[]; readonly currency: string; readonly llmRoles?: readonly string[] }): SoftwareSimulationDefinition {
  const { roles, engineers } = assignRoles(input.roster)
  return build({ policy: input.policy, seed: input.seed, currency: input.currency, roles, engineers, llmRoles: input.llmRoles ?? [], requests: DEMO_SCENARIO.requests, horizonDays: DEMO_SCENARIO.horizonDays, limits: DEMO_SCENARIO.limits })
}

/** A clone shares the world, not the history (M30 §2.3). The policy's three knobs are the policy,
 *  not free-standing settings, so a clone into B is a careful run — copying A's `reviewEverything`
 *  under the name "B" would be a definition that contradicts its own label. */
export function cloneDefinition(definition: SoftwareSimulationDefinition, over: { readonly policy: SoftwarePolicy; readonly seed: number }): SoftwareSimulationDefinition {
  const copy = JSON.parse(JSON.stringify(definition)) as SoftwareSimulationDefinition
  return softwareSimulationDefinitionSchema.parse({ ...copy, policy: over.policy, seed: over.seed, ...POLICY_SETTINGS[over.policy] }) as SoftwareSimulationDefinition
}

/** Every scenario request is scheduled as an `external`-priority event on its own day, exactly as
 *  trade schedules demand — so day 1's product decision already sees day 1's requests. */
export function softwareInitialEngineState(definition: SoftwareSimulationDefinition): EngineState<SoftwareState, SoftwareEvent> {
  const scenario: ScheduleRequest<SoftwareEvent>[] = definition.scenario.requests.map((r) => ({ time: r.day, priority: 'external', event: { type: 'request', area: r.area, sizeDays: r.sizeDays, dueInDays: r.dueInDays } }))
  const state = initialSoftwareState({ engineers: definition.engineers, reviewCapacityPerDay: definition.reviewCapacityPerDay, reviewEverything: definition.reviewEverything, matchWaitDays: definition.matchWaitDays })
  return initialEngineState(state, scenario, definition.seed)
}
