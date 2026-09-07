export * from './core/rng.js'
export * from './core/queue.js'
export * from './core/journal.js'
export * from './core/action.js'
export * from './core/action-docs.js'
export * from './core/sector.js'
export * from './core/engine.js'
export * from './core/plugin.js'
export * from './core/registry.js'
export * from './decide/provider.js'
export * from './decide/recorded.js'
export * from './decide/llm.js'
export * from './decide/llm-prompt.js'
export * from './trade/state.js'
export * from './trade/events.js'
export * from './trade/actions.js'
export * from './trade/action-docs.js'
export * from './trade/model.js'
export * from './trade/definition.js'
export * from './trade/rules.js'
export * from './trade/metrics.js'
export * from './trade/plugin.js'
export * from './software/state.js'
export * from './software/events.js'
// Trade got to the plain names first (`demoDefinition`, `assignRoles`, `DEMO_SCENARIO`,
// `noteParams`), and a barrel cannot export one name twice. Inside `src/software/*` the names
// stay as the design writes them; only the package's public surface disambiguates them. Nothing
// outside this package reaches for either sector by name anyway -- control and web go through
// `sectors` / `sectorFor` (design §1 principle 1).
export { acceptRequestParams, assignTaskParams, reviewTaskParams, noteParams as softwareNoteParams, SOFTWARE_ACTION_TYPES, SOFTWARE_ACTION_DOCS, type SoftwareActionType, type SoftwareRejection } from './software/actions.js'
export * from './software/model.js'
export {
  assignRoles as assignSoftwareRoles,
  cloneDefinition as cloneSoftwareDefinition,
  demoDefinition as softwareDemoDefinition,
  DEMO_SCENARIO as SOFTWARE_DEMO_SCENARIO,
  POLICY_SETTINGS as SOFTWARE_POLICY_SETTINGS,
  rosterFits as softwareRosterFits,
  softwareInitialEngineState,
  softwareSimulationDefinitionSchema,
  SOFTWARE_ROLE_NAMES,
  SOFTWARE_ROSTER_REQUIREMENT,
  type SoftwareEngineerSpec,
  type SoftwarePolicy,
  type SoftwareRoleName,
  type SoftwareRosterEntry,
  type SoftwareSimulationDefinition,
} from './software/definition.js'
export * from './software/rules.js'
export * from './software/metrics.js'
export * from './software/plugin.js'
