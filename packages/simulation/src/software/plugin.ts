import type { ExternalEventForm, SectorPlugin } from '../core/plugin.js'
import { SOFTWARE_ACTION_DOCS, type SoftwareRejection } from './actions.js'
import { cloneDefinition, demoDefinition, rosterFits, softwareInitialEngineState, softwareSimulationDefinitionSchema, SOFTWARE_ROSTER_REQUIREMENT, type SoftwareSimulationDefinition } from './definition.js'
import { softwareExternalEventSchema, type SoftwareEvent } from './events.js'
import { softwareMetrics, type SoftwareMetrics } from './metrics.js'
import { softwareModel } from './model.js'
import { SoftwareRulesDecisionProvider } from './rules.js'
import { softwareStateSchema, type SoftwareState } from './state.js'

// Every metric is a number, so unlike trade there is nothing to exclude: the label set IS the
// metric set. A mapped type rather than the interface itself so it satisfies `M extends
// Record<string, number>` (an interface never is — see the trade plugin's note on TS2344).
type SoftwareMetricLabelSet = { [K in keyof SoftwareMetrics]: SoftwareMetrics[K] }

type SoftwarePlugin = SectorPlugin<SoftwareState, SoftwareEvent, SoftwareRejection, SoftwareSimulationDefinition, SoftwareMetricLabelSet>

const METRIC_LABELS: SoftwarePlugin['metricLabels'] = {
  deliveredTasks: { label: 'delivered', kind: 'count' },
  onTimeTasks: { label: 'on time', kind: 'count' },
  lateTasks: { label: 'late', kind: 'count' },
  // Reported to a tenth of a day (ruling R7): stable across runs, and fine enough to show the
  // difference between two policies that whole days rounded away.
  avgLeadDays: { label: 'average lead time', kind: 'days' },
  reworkTasks: { label: 'tasks reworked', kind: 'count' },
  defectIncidents: { label: 'defect incidents', kind: 'count' },
  queueMaxLength: { label: 'longest queue', kind: 'count' },
  reviewBacklogMax: { label: 'largest review backlog', kind: 'count' },
  idleEngineerDays: { label: 'idle engineer-days', kind: 'days' },
  openTasks: { label: 'still open', kind: 'count' },
}

// No `testId`s: the trade forms carry them because M29/M30's run page already had inputs a test
// targeted by name (ruling R1). Software's inputs are new, so task 4 derives `sim-inject-<name>`
// from the field name and there is nothing here to preserve.
const EXTERNAL_EVENT_FORMS: readonly ExternalEventForm[] = [
  {
    type: 'request',
    label: 'feature request',
    fields: [
      { name: 'area', label: 'area', kind: 'select', optionsFrom: 'areas' },
      { name: 'sizeDays', label: 'size (days)', kind: 'int' },
      { name: 'dueInDays', label: 'due in days', kind: 'int' },
    ],
  },
  { type: 'incident', label: 'incident', fields: [{ name: 'area', label: 'area', kind: 'select', optionsFrom: 'areas' }] },
  {
    type: 'absence',
    label: 'absence',
    fields: [
      { name: 'engineerId', label: 'engineer', kind: 'select', optionsFrom: 'engineers' },
      { name: 'days', label: 'days', kind: 'int' },
    ],
  },
]

const AREAS = [
  { id: 'backend', label: 'backend' },
  { id: 'frontend', label: 'frontend' },
  { id: 'devops', label: 'devops' },
] as const

/** The software sector as a plugin (M31b design §3): a queue, expertise, review capacity, and the
 *  rework a skipped review buys three days later. */
export const softwarePlugin: SoftwarePlugin = {
  name: 'software',
  model: softwareModel,
  // Same cast as trade's, and for the same reason: `llmRoles` carries `.default([])`, so only the
  // schema's OUTPUT type matches the definition — its INPUT has the field optional.
  definitionSchema: softwareSimulationDefinitionSchema as unknown as SoftwarePlugin['definitionSchema'],
  stateSchema: softwareStateSchema,
  externalEventSchema: softwareExternalEventSchema,
  rosterRequirement: SOFTWARE_ROSTER_REQUIREMENT,
  // §3.4's two policies in one line each: A is fast, B is careful.
  policyLabels: { A: 'A — first free engineer, review only incidents', B: 'B — wait for matching expertise, review everything' },
  rosterFits,
  demoDefinition,
  cloneDefinition,
  initialState: softwareInitialEngineState,
  rulesProvider: (definition) => new SoftwareRulesDecisionProvider(definition),
  metrics: softwareMetrics,
  metricLabels: METRIC_LABELS,
  headline: (state) => [
    { label: 'queued', value: state.tasks.filter((t) => t.status === 'queued').length, kind: 'count' },
    { label: 'in progress', value: state.tasks.filter((t) => t.status === 'in_progress').length, kind: 'count' },
    { label: 'in review', value: state.tasks.filter((t) => t.status === 'in_review').length, kind: 'count' },
    { label: 'done', value: state.tasks.filter((t) => t.status === 'done').length, kind: 'count' },
    { label: 'open incidents', value: state.tasks.filter((t) => t.priority === 'incident' && t.status !== 'done').length, kind: 'count' },
  ],
  actionDocs: SOFTWARE_ACTION_DOCS,
  externalEventForms: EXTERNAL_EVENT_FORMS,
  injectOptions: (state) => ({ areas: AREAS.map((a) => ({ ...a })), engineers: state.engineers.map((e) => ({ id: e.id, label: `${e.id} (${e.expertise})` })) }),
  llmRoleCandidates: ['lead'],
  // Software's world: the three decision roles, the engineer pool (its ids AND their expertise --
  // the same twelve requests against a different pool is a different world), the scenario, and the
  // three frame numbers. `roster` and `initial` are trade's fields and this sector has neither, so
  // they are gone rather than compared as `undefined`.
  //
  // NOT here, deliberately: `reviewCapacityPerDay`, `reviewEverything` and `matchWaitDays`. They
  // are `POLICY_SETTINGS[policy]` verbatim -- `cloneDefinition` overwrites them from the new
  // policy -- so they ARE the policy, and comparing them would make every A-vs-B comparison read
  // "the runs did not share the same world", which is exactly what compare exists to deny.
  comparedKeys: ['roles', 'engineers', 'scenario', 'currency', 'horizonDays', 'limits'],
}
