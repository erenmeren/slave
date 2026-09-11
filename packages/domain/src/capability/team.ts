import { capabilityLabel, projectRoles, type CapabilityKey, type CapabilityRecord } from './taxonomy.js'

export interface TeamRosterMember {
  readonly slaveId: string
  readonly name: string
  readonly capabilities: readonly CapabilityKey[]
  readonly runtimeRoles: readonly string[]
  readonly busy: boolean
}

export interface TeamCompanyWorker {
  readonly companySlaveId: string
  readonly name: string
  readonly capabilities: readonly CapabilityKey[]
}

export interface TeamCatalogEntry {
  readonly templateId: string
  readonly name: string
  readonly capabilities: readonly CapabilityKey[]
  readonly division: string | null
}

export interface TeamInput {
  /** The capabilities the BOARD needs -- the union over its ready and blocked tasks. */
  readonly required: readonly CapabilityKey[]
  /**
   * WHICH startable tasks need each capability (M50 R2) -- the task ids per key, from the SAME
   * staffable tasks {@link TeamInput.required} is built from (`teamPlanOf`, one pass over one
   * filtered array; plan erratum E3). It is what makes "one assignment" answerable here rather than
   * guessable: a gap exactly one task has is a job, and a gap two tasks share is a seat.
   *
   * A key that is absent, or whose list is empty, has no sole assignment and can never become a
   * temporary hire -- which is what an unfilled map means, and why every caller written before
   * this milestone keeps behaving exactly as it did.
   */
  readonly requiredBy: ReadonlyMap<CapabilityKey, readonly string[]>
  readonly roster: readonly TeamRosterMember[]
  /** The company's roster rows that are NOT already materialised into this project. */
  readonly company: readonly TeamCompanyWorker[]
  readonly catalog: readonly TeamCatalogEntry[]
  readonly taxonomy: readonly CapabilityRecord[]
  /** Templates a current worker's own profile recommends pairing with (R5). A tie-break and a
   *  sentence, never a dispatch. */
  readonly recommendedTemplateIds?: readonly string[]
}

/** Where a proposed worker would come from, in the preference order R4 fixes: an existing capable
 *  worker, an existing company worker, a new project worker, a temporary specialist. `temporary` is
 *  a CATALOG pick whose gap belongs to exactly one startable task (M50 R2) -- the same hire, with
 *  an end written into it. */
export type TeamSource = 'existing_worker' | 'company_worker' | 'project_worker' | 'temporary'

export interface TeamProposal {
  readonly capability: CapabilityKey
  readonly source: TeamSource
  readonly pick: { readonly kind: 'slave' | 'company_slave' | 'template'; readonly id: string; readonly name: string }
  /** Every missing capability this one pick would cover -- what makes "one worker instead of two"
   *  visible to a person rather than implicit in the count. */
  readonly covers: readonly CapabilityKey[]
  /** M50 R2: true exactly when {@link TeamProposal.source} is `temporary`. Kept as its own field
   *  because the ACTION carries it as a flag and a decision row read a year later must say what was
   *  claimed. */
  readonly temporary: boolean
  /** The ONE assignment a temporary specialist is being asked for (M50 R2, plan erratum E1), null
   *  on every other source. Carried on the proposal because `actionOf` -- which builds the action
   *  the decision stores -- is handed a proposal and a world, and {@link TeamInput.requiredBy} is
   *  an input to this function that neither of them can reach. */
  readonly engagementTaskId: string | null
  readonly rationale: string
}

export interface TeamPlan {
  readonly covered: readonly { readonly capability: CapabilityKey; readonly by: string }[]
  readonly proposals: readonly TeamProposal[]
  readonly unfillable: readonly CapabilityKey[]
}

/**
 * The smallest team that covers what the board needs (M47 R4). Pure and deterministic: the same
 * input always produces the same plan, whatever order the caller's queries returned rows in --
 * every list is sorted before it is walked and every tie has a named break.
 *
 * A capability is COVERED when somebody in the roster already holds the role it projects to
 * (plan erratum E8): that is the dispatch condition, and it is the only one that matters, because
 * `decide()` matches roles. Everything else is a gap, and the gaps are filled in R4's order:
 *
 *  1. an existing worker who PROVIDES the capability but was never given its role -- one
 *     `set_runtime_roles` away from dispatchable, and the cheapest fix there is;
 *  2. a company roster worker not yet on this project;
 *  3. a catalog template, chosen by SET COVER: the entry covering the most still-missing
 *     capabilities wins, so one worker who can do two things beats two who can do one each.
 *
 * Anything left is `unfillable` and is reported rather than quietly dropped -- "nobody anywhere
 * can do this" is the one answer a person most needs to see.
 */
export function formTeam(input: TeamInput): TeamPlan {
  const required = [...new Set(input.required)].toSorted()
  const roster = [...input.roster].toSorted((a, b) => a.slaveId.localeCompare(b.slaveId))
  const recommended = new Set(input.recommendedTemplateIds ?? [])

  const covered: { capability: CapabilityKey; by: string }[] = []
  const missing: CapabilityKey[] = []
  for (const capability of required) {
    const role = projectRoles([capability], input.taxonomy)[0]
    const holder = role === undefined ? undefined : roster.find((member) => member.runtimeRoles.includes(role))
    if (holder === undefined) missing.push(capability)
    else covered.push({ capability, by: holder.slaveId })
  }

  const proposals: TeamProposal[] = []
  const outstanding = new Set(missing)

  // 1. The existing capable worker: idle first (a busy worker's roles must not change under its
  // own run), then slave id. Grouped BY WORKER (fix round 1) so one person who provides three of
  // the gaps is one proposal covering three, not three proposals naming the same person -- the
  // same minimality rule the other two tiers already followed, and the same `covers` list a reader
  // uses to see what one decision buys.
  const byProvider = new Map<string, { member: TeamRosterMember; covers: CapabilityKey[] }>()
  for (const capability of missing) {
    // A capability the taxonomy does not have projects to no role, so there is no role to grant
    // and nothing to propose: the "make them dispatchable" sentence would name an empty role.
    // Left outstanding instead, and reported as unfillable unless somebody else provides it.
    if (projectRoles([capability], input.taxonomy).length === 0) continue
    const provider = roster
      .filter((member) => member.capabilities.includes(capability))
      .toSorted((a, b) => (a.busy === b.busy ? a.slaveId.localeCompare(b.slaveId) : a.busy ? 1 : -1))[0]
    if (provider === undefined) continue
    const group = byProvider.get(provider.slaveId)
    if (group === undefined) byProvider.set(provider.slaveId, { member: provider, covers: [capability] })
    else group.covers.push(capability)
    outstanding.delete(capability)
  }

  for (const { member, covers } of byProvider.values()) {
    // `covers` is already in `required` order, which is sorted -- so the proposal's own key is the
    // first of them and the plan is the same whatever order the roster came back in.
    const roles = projectRoles(covers, input.taxonomy)
    proposals.push({
      capability: covers[0] as CapabilityKey,
      source: 'existing_worker',
      pick: { kind: 'slave', id: member.slaveId, name: member.name },
      covers,
      temporary: false,
      engagementTaskId: null,
      rationale:
        `${member.name} already provides ${labelList(covers, input.taxonomy)} and does not hold the ` +
        `${roles.map((role) => `"${role}"`).join(' and ')} runtime role${roles.length === 1 ? '' : 's'}, so ` +
        `granting ${roles.length === 1 ? 'it' : 'them'} makes them dispatchable for this work with nobody new.`,
    })
  }

  // 2 and 3. Set cover over the company roster first, then the catalog. Both loops are the same
  // shape, so a change to the minimality rule is one change and not two.
  coverWith(
    outstanding,
    [...input.company].toSorted((a, b) => a.companySlaveId.localeCompare(b.companySlaveId)).map((worker) => ({
      id: worker.companySlaveId,
      name: worker.name,
      capabilities: worker.capabilities,
      recommended: false,
    })),
    (pick, covers) =>
      proposals.push({
        capability: covers[0] as CapabilityKey,
        source: 'company_worker',
        pick: { kind: 'company_slave', id: pick.id, name: pick.name },
        covers,
        temporary: false,
        engagementTaskId: null,
        rationale:
          `${pick.name} is already on the company roster and provides ${labelList(covers, input.taxonomy)}, so this ` +
          'project can be staffed from people who already work here rather than by hiring.',
      }),
  )

  coverWith(
    outstanding,
    [...input.catalog].toSorted((a, b) => a.templateId.localeCompare(b.templateId)).map((entry) => ({
      id: entry.templateId,
      name: entry.name,
      capabilities: entry.capabilities,
      recommended: recommended.has(entry.templateId),
    })),
    (pick, covers) => {
      // M50 R2. The ONE difference between a hire and a temporary hire is how much work is waiting:
      // one startable task is an assignment, two are a seat. Everything else about the pick -- how
      // it was chosen, what it covers, the tie-breaks it won -- is identical, which is why this is
      // a field on the proposal rather than a fourth tier of the search.
      const engagementTaskId = soleTaskFor(covers, input.requiredBy)
      const recommendedClause = pick.recommended ? ", and a worker's profile recommends pairing with it" : ''
      proposals.push({
        capability: covers[0] as CapabilityKey,
        source: engagementTaskId === null ? 'project_worker' : 'temporary',
        pick: { kind: 'template', id: pick.id, name: pick.name },
        covers,
        temporary: engagementTaskId !== null,
        engagementTaskId,
        rationale:
          engagementTaskId === null
            ? `${pick.name} provides ${labelList(covers, input.taxonomy)}, which nobody on this project or on the ` +
              `company roster does${recommendedClause}.`
            : `${pick.name} provides ${labelList(covers, input.taxonomy)}, which nobody on this project or on the ` +
              `company roster does, and exactly one piece of startable work needs it -- so this is one assignment ` +
              `rather than a standing seat${recommendedClause}.`,
      })
    },
  )

  return {
    covered,
    proposals: proposals.toSorted((a, b) => a.capability.localeCompare(b.capability)),
    unfillable: [...outstanding].toSorted(),
  }
}

/** One round of greedy set cover, repeated until nothing else can be covered. The winner is the
 *  candidate covering the most outstanding capabilities; ties break on RECOMMENDED first (R5's
 *  advisory tie-break), then on the fewest total capabilities (the most specific worker for the
 *  job), then on name, then on id -- four breaks, so the winner never depends on input order. */
function coverWith(
  outstanding: Set<CapabilityKey>,
  candidates: readonly { readonly id: string; readonly name: string; readonly capabilities: readonly CapabilityKey[]; readonly recommended: boolean }[],
  emit: (pick: { readonly id: string; readonly name: string; readonly recommended: boolean }, covers: readonly CapabilityKey[]) => void,
): void {
  while (outstanding.size > 0) {
    let best: Candidate | null = null
    for (const candidate of candidates) {
      const covers = [...outstanding].filter((capability) => candidate.capabilities.includes(capability)).toSorted()
      if (covers.length === 0) continue
      const challenger = { ...candidate, covers }
      if (best === null || beats(challenger, best)) best = challenger
    }
    // Nothing left that anybody here covers: every further round would find the same nothing.
    if (best === null) return
    emit(best, best.covers)
    for (const capability of best.covers) outstanding.delete(capability)
  }
}

/** One candidate for a round of {@link coverWith}, with the outstanding keys it would cover. */
interface Candidate {
  readonly id: string
  readonly name: string
  readonly capabilities: readonly CapabilityKey[]
  readonly recommended: boolean
  readonly covers: readonly CapabilityKey[]
}

/** The four tie-breaks, read off both candidates directly (fix round 1): the holder's total
 *  capability count used to be looked up again in `candidates`, and the `?? 0` that lookup fell
 *  back to would have let a holder nobody could find win the "most specific worker" break
 *  unconditionally. */
function beats(challenger: Candidate, holder: Candidate): boolean {
  if (challenger.covers.length !== holder.covers.length) return challenger.covers.length > holder.covers.length
  if (challenger.recommended !== holder.recommended) return challenger.recommended
  if (challenger.capabilities.length !== holder.capabilities.length) {
    return challenger.capabilities.length < holder.capabilities.length
  }
  if (challenger.name !== holder.name) return challenger.name.localeCompare(holder.name) < 0
  return challenger.id.localeCompare(holder.id) < 0
}

const labelList = (keys: readonly CapabilityKey[], taxonomy: readonly CapabilityRecord[]): string =>
  keys.map((key) => capabilityLabel(key, taxonomy)).join(' and ')

/**
 * The ONE task every capability in `covers` is required by, or null (M50 R2, plan erratum E2).
 *
 * A catalog pick covers a SET -- that minimality is what M47 is named for -- so "the capability it
 * covers is required by exactly one task" has to be read over the UNION of the tasks behind those
 * keys. One worker brought in for two capabilities the same task needs is still one assignment;
 * two capabilities two different tasks need is a seat, whoever fills it.
 *
 * Null for an empty list as well as for a crowded one: a key nothing is recorded as needing cannot
 * name the assignment a release would later be measured against, and a temporary worker with no
 * engagement is one nothing can ever release.
 */
function soleTaskFor(
  covers: readonly CapabilityKey[],
  requiredBy: ReadonlyMap<CapabilityKey, readonly string[]>,
): string | null {
  const tasks = new Set<string>()
  for (const capability of covers) {
    const waiting = requiredBy.get(capability) ?? []
    if (waiting.length === 0) return null
    for (const taskId of waiting) tasks.add(taskId)
    if (tasks.size > 1) return null
  }
  return tasks.size === 1 ? ([...tasks][0] as string) : null
}
