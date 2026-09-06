import { z } from 'zod'
import { initialEngineState, type EngineDefinition, type EngineState } from '../core/engine.js'
import type { RoleDefinition, ScheduleRequest } from '../core/sector.js'
import { tradeExternalEventSchema, type TradeEvent } from './events.js'
import { initialTradeState, supplierSchema, type TradeState } from './state.js'

export const TRADE_ROLE_NAMES = ['sales', 'purchasing', 'operations', 'finance'] as const
export type TradeRoleName = (typeof TRADE_ROLE_NAMES)[number]
export type TradePolicy = 'A' | 'B'

const roleSchema = z.object({ name: z.string(), purpose: z.string(), observes: z.array(z.string()), allowedActions: z.array(z.string()), constraints: z.record(z.number()), slaveName: z.string() })
const scenarioEventSchema = z.object({ day: z.number().int().nonnegative(), event: tradeExternalEventSchema })

export const tradeSimulationDefinitionSchema = z.object({
  sector: z.literal('trade'),
  synthetic: z.literal(true),
  currency: z.string().min(3).max(3),
  policy: z.enum(['A', 'B']),
  seed: z.number().int(),
  horizonDays: z.number().int().positive(),
  limits: z.object({ maxSteps: z.number().int().positive(), maxDecisionsPerStep: z.number().int().positive(), maxJournalEntries: z.number().int().positive() }),
  roles: z.array(roleSchema),
  roleOrder: z.array(z.string()),
  roster: z.array(z.object({ slaveName: z.string(), departmentName: z.string() })),
  initial: z.object({ cashMinor: z.number().int(), inventory: z.number().int().nonnegative(), dailyShipCapacity: z.number().int().positive(), suppliers: z.array(supplierSchema) }),
  scenario: z.array(scenarioEventSchema),
})
export type TradeSimulationDefinition = z.infer<typeof tradeSimulationDefinitionSchema> & EngineDefinition
export type TradeRosterEntry = { readonly slaveName: string; readonly departmentName: string }

/** The synthetic demo (spec §5.4). Not a real company; every number is an assumption. */
export const DEMO_SCENARIO = {
  currency: 'USD',
  horizonDays: 30,
  initial: {
    cashMinor: 5_000_000,
    inventory: 100,
    dailyShipCapacity: 30,
    suppliers: [
      { id: 'normal', name: 'Normal Supply', unitPriceMinor: 6_000, leadDays: 7, paymentTermDays: 30 },
      { id: 'fast', name: 'Fast Supply', unitPriceMinor: 8_500, leadDays: 2, paymentTermDays: 0 },
    ],
  },
  scenario: [
    { day: 1, event: { type: 'demand' as const, qty: 150, unitPriceMinor: 12_000, dueInDays: 10, collectInDays: 15 } },
    { day: 3, event: { type: 'supplier_delay' as const, supplierId: 'normal', extraDays: 6 } },
  ],
  limits: { maxSteps: 365, maxDecisionsPerStep: 8, maxJournalEntries: 20_000 },
} as const

const OBSERVES: Readonly<Record<TradeRoleName, readonly string[]>> = {
  sales: ['pendingDemand', 'orders', 'inventory'],
  purchasing: ['inventory', 'cashMinor', 'orders', 'purchases', 'suppliers', 'dailyShipCapacity'],
  operations: ['inventory', 'orders', 'dailyShipCapacity', 'shippedToday'],
  finance: ['cashMinor', 'purchases', 'orders', 'minCashMinor'],
}
const ALLOWED: Readonly<Record<TradeRoleName, readonly string[]>> = {
  sales: ['accept_order', 'note'],
  purchasing: ['place_purchase', 'note'],
  operations: ['ship_order', 'note'],
  finance: ['note'],
}
const PURPOSE: Readonly<Record<TradeRoleName, string>> = {
  sales: 'accepts customer demand into orders',
  purchasing: 'keeps stock able to cover open orders within cash',
  operations: 'ships open orders within the daily capacity',
  finance: 'watches cash and commitments',
}

/** Maps the four roles onto the frozen roster: by department name first, then by position. */
export function assignRoles(roster: readonly TradeRosterEntry[]): RoleDefinition[] {
  if (roster.length < TRADE_ROLE_NAMES.length) throw new Error(`the trade sector needs four slaves for its four roles; the roster has ${roster.length}`)
  const taken = new Set<string>()
  const pick = (role: TradeRoleName): string => {
    const byDepartment = roster.find((r) => r.departmentName.toLowerCase() === role && !taken.has(r.slaveName))
    const chosen = byDepartment ?? roster.find((r) => !taken.has(r.slaveName))
    if (chosen === undefined) throw new Error('roster exhausted')
    taken.add(chosen.slaveName)
    return chosen.slaveName
  }
  return TRADE_ROLE_NAMES.map((name) => ({ name, purpose: PURPOSE[name], observes: [...OBSERVES[name]], allowedActions: [...ALLOWED[name]], constraints: name === 'purchasing' ? { maxPurchaseQty: 500 } : {}, slaveName: pick(name) }))
}

export function demoDefinition(input: { readonly policy: TradePolicy; readonly seed: number; readonly roster: readonly TradeRosterEntry[]; readonly currency: string }): TradeSimulationDefinition {
  const roles = assignRoles(input.roster)
  return tradeSimulationDefinitionSchema.parse({
    sector: 'trade', synthetic: true, currency: input.currency, policy: input.policy, seed: input.seed,
    horizonDays: DEMO_SCENARIO.horizonDays, limits: DEMO_SCENARIO.limits, roles, roleOrder: [...TRADE_ROLE_NAMES],
    roster: input.roster, initial: DEMO_SCENARIO.initial, scenario: DEMO_SCENARIO.scenario,
  }) as TradeSimulationDefinition
}

export function tradeInitialEngineState(definition: TradeSimulationDefinition): EngineState<TradeState, TradeEvent> {
  const scenario: ScheduleRequest<TradeEvent>[] = definition.scenario.map((s) => ({ time: s.day, priority: 'external', event: s.event }))
  return initialEngineState(initialTradeState(definition.initial), scenario, definition.seed)
}
