import type { ExternalEventForm, SectorPlugin } from '../core/plugin.js'
import { TRADE_ACTION_DOCS } from './action-docs.js'
import type { TradeRejection } from './actions.js'
import { cloneDefinition, demoDefinition as tradeDemoDefinition, tradeInitialEngineState, tradeSimulationDefinitionSchema, TRADE_ROSTER_REQUIREMENT, type TradeSimulationDefinition } from './definition.js'
import { tradeExternalEventSchema, type TradeEvent } from './events.js'
import { tradeMetrics, type TradeMetrics } from './metrics.js'
import { tradeModel } from './model.js'
import { RulesDecisionProvider } from './rules.js'
import { tradeStateSchema, type TradeState } from './state.js'

/** The nine metrics the run page labels (`apps/web/src/components/sim/SimulationClient.tsx:19`),
 *  as the `M` the plugin contract wants: `TradeMetrics` also carries `minCashDay` and `sources`,
 *  read directly by the panel rather than through a label -- see the conformance test's note on
 *  `metricLabels`. A mapped type (not a second `interface`) so it actually satisfies `M extends
 *  Record<string, number>`: an `interface`, however numeric every property, is never assignable
 *  to an index-signature constraint (TS2344) the way a mapped type is. */
type TradeMetricLabelSet = { [K in Exclude<keyof TradeMetrics, 'sources' | 'minCashDay'>]: TradeMetrics[K] }

type TradePlugin = SectorPlugin<TradeState, TradeEvent, TradeRejection, TradeSimulationDefinition, TradeMetricLabelSet>

const METRIC_LABELS: TradePlugin['metricLabels'] = {
  deliveredQty: { label: 'delivered', kind: 'count' },
  onTimeQty: { label: 'on time', kind: 'count' },
  lateDays: { label: 'late days', kind: 'days' },
  purchaseCostMinor: { label: 'purchase cost', kind: 'money' },
  closingInventory: { label: 'closing stock', kind: 'count' },
  closingCashMinor: { label: 'closing cash', kind: 'money' },
  minCashMinor: { label: 'minimum cash', kind: 'money' },
  collectedMinor: { label: 'collected', kind: 'money' },
  unpaidCommitmentsMinor: { label: 'unpaid commitments', kind: 'money' },
}

// Real form field names (`src/trade/events.ts`'s `demand`/`supplier_delay`) and the run page's
// own `data-testid`s (`apps/web/src/components/sim/SimulationClient.tsx`, the inject drawer) --
// verified against both files rather than trusted from memory, per the task-1 brief's ruling R1.
// Note: the unit-price field's testid is `sim-inject-price`, not `sim-inject-unit-price`.
const EXTERNAL_EVENT_FORMS: readonly ExternalEventForm[] = [
  {
    type: 'demand',
    label: 'customer demand',
    fields: [
      { name: 'qty', label: 'qty', kind: 'int', testId: 'sim-inject-qty' },
      { name: 'unitPriceMinor', label: 'unit price', kind: 'money', testId: 'sim-inject-price' },
      { name: 'dueInDays', label: 'due in days', kind: 'int', testId: 'sim-inject-due' },
      { name: 'collectInDays', label: 'collect in days', kind: 'int', testId: 'sim-inject-collect' },
    ],
  },
  {
    type: 'supplier_delay',
    label: 'supplier delay',
    fields: [
      { name: 'supplierId', label: 'supplier', kind: 'select', optionsFrom: 'suppliers', testId: 'sim-inject-supplier' },
      { name: 'extraDays', label: 'extra days', kind: 'int', testId: 'sim-inject-extra-days' },
    ],
  },
]

/** The trade plugin (M31b task 1): a re-export of what M29/M30/M31a already built, wrapped to the
 *  `SectorPlugin` contract -- not a rewrite (M31b design §1 principle 2, "trade is pixel-identical"). */
export const tradePlugin: TradePlugin = {
  name: 'trade',
  model: tradeModel,
  // `z.ZodType<D>`'s default Input type param is D itself (`llmRoles: string[]`, required), but
  // the real schema's INPUT type has `llmRoles` optional (it carries `.default([])`) -- only its
  // OUTPUT matches D. The cast is the same shape as `TRADE_SIMULATION_DEFINITION_SCHEMA`'s own
  // callers already use (`demoDefinition`/`cloneDefinition` end in `as TradeSimulationDefinition`
  // for the identical reason); nothing about parsing changes.
  definitionSchema: tradeSimulationDefinitionSchema as unknown as TradePlugin['definitionSchema'],
  stateSchema: tradeStateSchema,
  externalEventSchema: tradeExternalEventSchema,
  rosterRequirement: TRADE_ROSTER_REQUIREMENT,
  rosterFits: (roster) => roster.length >= 4,
  demoDefinition: tradeDemoDefinition,
  cloneDefinition,
  initialState: tradeInitialEngineState,
  rulesProvider: (definition) => new RulesDecisionProvider(definition),
  metrics: tradeMetrics,
  metricLabels: METRIC_LABELS,
  headline: (state, day) => [
    { label: 'day', value: day, kind: 'count', ofHorizon: true },
    { label: 'cash', value: state.cashMinor, kind: 'money' },
    { label: 'inventory', value: state.inventory, kind: 'count' },
    { label: 'open orders', value: state.orders.filter((o) => o.status !== 'shipped').length, kind: 'count' },
    { label: 'pending demand', value: state.pendingDemand.length, kind: 'count' },
    { label: 'inbound purchases', value: state.purchases.filter((p) => p.status === 'ordered').length, kind: 'count' },
    { label: 'daily ship capacity', value: state.dailyShipCapacity, kind: 'count' },
  ],
  actionDocs: TRADE_ACTION_DOCS,
  externalEventForms: EXTERNAL_EVENT_FORMS,
  injectOptions: (state) => ({ suppliers: state.suppliers.map((s) => ({ id: s.id, label: s.name })) }),
  llmRoleCandidates: ['purchasing'],
}
