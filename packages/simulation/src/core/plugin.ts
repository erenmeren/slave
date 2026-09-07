import type { z } from 'zod'
import type { ActionDoc } from './action-docs.js'
import type { DecisionProvider } from '../decide/provider.js'
import type { EngineDefinition, EngineState } from './engine.js'
import type { JournalEntry } from './journal.js'
import type { SectorModel } from './sector.js'

/** M31b design §2, copied verbatim. A sector is a plugin, not a branch: everything
 *  sector-specific -- schemas, model, rules, metrics, demo, forms -- lives under one
 *  `SectorPlugin` value; control and web never name a sector except through the registry
 *  (`./registry.js`). */
export interface MetricLabel { readonly label: string; readonly kind: 'count' | 'money' | 'days' }
// Controller ruling R14: `ofHorizon` is optional and new -- it marks the ONE headline item (a
// sector's "day" figure, if it has one) the run page renders as `${value} / ${horizonDays}`
// rather than a plain number, so the page never has to guess that by matching a label string.
export interface HeadlineItem { readonly label: string; readonly value: number; readonly kind: 'count' | 'money' | 'days'; readonly ofHorizon?: boolean }
// Controller ruling R1: `testId` is optional and new -- it lets a plugin's external-event form
// carry the exact `data-testid` the run page's inputs already use, so the trade plugin can wrap
// M29/M30's form without changing what a test (or an operator's muscle memory) targets.
// Final fix wave: `default` is optional and new -- the starting text the run page puts in the
// field. It exists because M29/M30's trade form opened on a plausible order (qty 10 at 120.00 due
// in 10 days) and the generic form regressed that to `1` / `0.00`; a sector that has no opinion
// omits it and gets the page's kind-based fallback. Written the way the field is TYPED, so a
// money field's default is major units ('120.00'), matching what the input shows.
export interface FormField { readonly name: string; readonly label: string; readonly kind: 'int' | 'money' | 'select'; readonly optionsFrom?: string; readonly testId?: string; readonly default?: string }   // optionsFrom names a key of injectOptions(state)
export interface ExternalEventForm { readonly type: string; readonly label: string; readonly fields: readonly FormField[] }
export interface RosterEntry { readonly slaveName: string; readonly departmentName: string; readonly role: string }

/** Every sector the platform knows, by name. Written out here rather than derived from the
 *  registry (review round 1, Minor): `SectorPlugin.name` IS a sector name, and a `SectorName` read
 *  as `keyof typeof sectors` would make the registry's own type circular. `./registry.js` checks
 *  with `satisfies` that its keys are exactly these, so the two can never drift. */
export type SectorName = 'trade' | 'software'

export interface SectorPlugin<S, E, R, D extends EngineDefinition, M extends Record<string, number>> {
  readonly name: SectorName
  readonly model: SectorModel<S, E, R>
  readonly definitionSchema: z.ZodType<D>
  readonly stateSchema: z.ZodType<S>
  readonly externalEventSchema: z.ZodType<E>
  readonly rosterRequirement: string                       // the refusal text when the roster cannot fill the roles
  // The two policies as a person reads them, in the drawer's own select. A sector's policies are
  // its own -- trade's A waits for the normal supplier, software's A takes whoever is free -- so
  // the prose belongs to the plugin, not to a drawer that would otherwise print trade's sentence
  // over every sector's runs (final fix wave).
  readonly policyLabels: Readonly<Record<'A' | 'B', string>>
  rosterFits(roster: readonly RosterEntry[]): boolean      // the same rule demoDefinition enforces, without building anything
  demoDefinition(input: { policy: 'A' | 'B'; seed: number; roster: readonly RosterEntry[]; currency: string; llmRoles?: readonly string[] }): D   // throws Error(rosterRequirement) on a short roster
  cloneDefinition(definition: D, over: { policy: 'A' | 'B'; seed: number }): D
  initialState(definition: D): EngineState<S, E>
  rulesProvider(definition: D): DecisionProvider
  metrics(entries: readonly JournalEntry[], state: S): M
  readonly metricLabels: Readonly<Record<keyof M & string, MetricLabel>>
  headline(state: S, day: number): readonly HeadlineItem[]  // the "company" panel
  readonly actionDocs: readonly ActionDoc[]
  readonly externalEventForms: readonly ExternalEventForm[]
  injectOptions(state: S): Readonly<Record<string, readonly { id: string; label: string }[]>>
  readonly llmRoleCandidates: readonly string[]            // trade: ['purchasing']; software: ['lead']
  /**
   * The definition fields two runs of this sector must agree on to have lived in the SAME world
   * (M30 §4, moved here by M32 item 5): what `compareSimulations` reports as `differences` and
   * `definitionsMatch`. Control used to keep a hand-written UNION of every sector's keys, which is
   * a list only its author knows to update -- a key a sector does not carry reads `undefined ===
   * undefined` on both sides and silently compares nothing, so a new sector's world was checked by
   * whichever of trade's keys it happened to share.
   *
   * `policy` and `seed` are never here: differing on them is the whole point of a clone, so
   * comparing them would report every A-vs-B comparison as a different world. Neither is anything
   * the policy DERIVES -- software's `reviewCapacityPerDay` / `reviewEverything` / `matchWaitDays`
   * are `POLICY_SETTINGS[policy]` and nothing else, so listing them would smuggle `policy` back in
   * under three other names.
   *
   * Every entry must be a real field of the sector's definition; the conformance test checks it.
   */
  readonly comparedKeys: readonly string[]
}

// The one place `any` is allowed in this package: the registry hands control an existential --
// a plugin whose five type parameters (state, event, rejection, definition, metrics) differ per
// sector and are never the same across `sectors`' entries. Control and web read a plugin only
// through this shape (`name`, `metricLabels`, `headline`, the schemas, the functions) and never
// reach into `S`/`E`/`R`/`D`/`M` themselves, so collapsing them to `any` here costs nothing at
// the only call sites that exist -- `sectorFor` and `Object.values(sectors)`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above; repo has no eslint config today, kept for if one lands.
export type AnySectorPlugin = SectorPlugin<any, any, any, any, any>
