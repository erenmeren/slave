import type { PermissionKind, PermissionRunKind } from '../permission/kinds.js'
import {
  rankCandidates,
  type RankCandidate,
  type RankContext,
  type RankEvidence,
  type RankPreference,
  type RankedCandidate,
} from './rank.js'
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
  /** M53 R8: what the six steps need to decide WITHIN a tier. Optional -- see {@link TeamRanking}. */
  readonly ranking?: TeamRanking
}

/**
 * What `rankCandidates` needs about a world, gathered once by `teamPlanOf` (M53 R8).
 *
 * OPTIONAL on {@link TeamInput}, and that is load-bearing rather than lenient: every caller written
 * before M53 -- and every fixture in `team.test.ts` -- keeps compiling and keeps getting exactly the
 * plan it got before, because with no ranking context the chain falls through to step 7 and the
 * candidate id, which IS the tie-break those callers already had.
 *
 * Every map is keyed on the CANDIDATE's own id (a `Slave.id`, a `CompanySlave.id` or a
 * `SlaveTemplate.id`), never on a profile key: a candidate is what this function ranks, and the
 * profile key is one of the things it looks up about one.
 */
export interface TeamRanking {
  /** R9: what a person asked for, per capability. */
  readonly preferences: ReadonlyMap<CapabilityKey, RankPreference>
  /** R3: one record per profile key, from the world's bounded read. */
  readonly evidence: ReadonlyMap<string, RankEvidence>
  /** R10: the `deny` rows per EXISTING worker, by `Slave.id`. Templates and company workers carry
   *  none and are neither favoured nor penalised for it. */
  readonly deniedKinds: ReadonlyMap<string, readonly PermissionKind[]>
  /** The catalog template behind each candidate, by the candidate's own id. R9's preference names a
   *  template, and this is how a roster worker is matched against one. */
  readonly templateOf: ReadonlyMap<string, string | null>
  /** The model each candidate would run on -- the resolved chain, by candidate id. */
  readonly modelOf: ReadonlyMap<string, string | null>
  /** R1: the profile key each candidate's record is looked up by, by candidate id. */
  readonly profileKeyOf: ReadonlyMap<string, string>
  /** R10: whose baseline the permission step reads. `implementation` for every staffing decision
   *  the Supervisor makes today. */
  readonly runKind: PermissionRunKind
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
 * One candidate, as the ranker reads it.
 *
 * Everything the ranking context does not know about a candidate answers its own neutral value: no
 * template, no model, no denies, no record -- which is exactly the state a caller with no `ranking`
 * at all is in, and is why that caller's order does not move. The profile key falls back to the
 * candidate's own id, which no `EvidenceRecord.profileKey` can ever equal (R1's keys are
 * `template:<id>` or `slave:<id>`), so the lookup answers "no record" rather than somebody else's.
 */
function rankCandidateFor(
  input: TeamInput,
  base: {
    readonly id: string
    readonly kind: RankCandidate['kind']
    readonly name: string
    readonly covers: readonly CapabilityKey[]
    readonly busy: boolean
  },
): RankCandidate {
  const ranking = input.ranking
  const profileKey = ranking?.profileKeyOf.get(base.id) ?? base.id
  return {
    ...base,
    profileKey,
    templateId: ranking?.templateOf.get(base.id) ?? null,
    model: ranking?.modelOf.get(base.id) ?? null,
    deniedKinds: ranking?.deniedKinds.get(base.id) ?? [],
    evidence: ranking?.evidence.get(profileKey) ?? null,
  }
}

/**
 * The six steps' context for one capability (M53 R8, plan erratum E21).
 *
 * `capabilityLabel` is resolved HERE, from the taxonomy this function is already handed, because the
 * preference rationale is prose a person reads and a raw `<domain>.<name>` key is not a word.
 * `runKind` defaults to `implementation`: every staffing decision the Supervisor makes today is
 * about implementation work, and a caller with no ranking context reads the same baseline.
 */
function contextFor(input: TeamInput, capability: CapabilityKey): RankContext {
  return {
    capability,
    capabilityLabel: capabilityLabel(capability, input.taxonomy),
    preference: input.ranking?.preferences.get(capability) ?? null,
    runKind: input.ranking?.runKind ?? 'implementation',
  }
}

/** The winner of one tier's field, and the step that won it. `null` for an empty field. */
function bestOf(input: TeamInput, capability: CapabilityKey, field: readonly RankCandidate[]): RankedCandidate | null {
  return rankCandidates(field, contextFor(input, capability))[0] ?? null
}

/**
 * The last of {@link beats}' five breaks, for tiers 2 and 3 (plan decision D25).
 *
 * M47 R4 fixed the minimality rule and M50 R5 added the recommendation tie-break; those four stay
 * exactly as they are, and only the id comparison underneath them becomes the record, the preference
 * and the cost. Reached only when two candidates cover the same number of outstanding keys, agree on
 * recommendation, hold the same number of capabilities in total and share a NAME -- so in practice
 * this decides between two profiles a person could not tell apart from the proposal.
 *
 * The capability the two are ranked FOR is the first of their two keys in sorted order, which makes
 * the comparison symmetric: which candidate happens to be the challenger this round cannot change
 * the answer. Both are `busy: false` because neither kind can be busy -- a company worker not yet
 * materialised into this project holds no run, and a catalog template is not a worker at all.
 */
function rankBreakFor(
  input: TeamInput,
  kind: RankCandidate['kind'],
): (challenger: Candidate, holder: Candidate) => boolean {
  return (challenger, holder) => {
    const left = challenger.covers[0] as CapabilityKey
    const right = holder.covers[0] as CapabilityKey
    const capability = left.localeCompare(right) <= 0 ? left : right
    const ranked = rankCandidates(
      [challenger, holder].map((one) =>
        rankCandidateFor(input, { id: one.id, kind, name: one.name, covers: one.covers, busy: false }),
      ),
      contextFor(input, capability),
    )
    return ranked[0]?.candidate.id === challenger.id
  }
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
  const byProvider = new Map<
    string,
    { member: TeamRosterMember; covers: CapabilityKey[]; decided: RankedCandidate }
  >()
  const memberById = new Map(roster.map((member) => [member.slaveId, member] as const))
  for (const capability of missing) {
    // A capability the taxonomy does not have projects to no role, so there is no role to grant
    // and nothing to propose: the "make them dispatchable" sentence would name an empty role.
    // Left outstanding instead, and reported as unfillable unless somebody else provides it.
    if (projectRoles([capability], input.taxonomy).length === 0) continue
    // M53 R8: the six steps decide WITHIN the tier. `covers` is one capability here by
    // construction, so step 1 always ties and steps 2-7 are what choose -- which is exactly the
    // `busy`-then-`slaveId` sort this replaces, with four more reasons in front of the id.
    const field = roster
      .filter((member) => member.capabilities.includes(capability))
      .map((member) =>
        rankCandidateFor(input, {
          id: member.slaveId,
          kind: 'slave',
          name: member.name,
          covers: [capability],
          busy: member.busy,
        }),
      )
    const decided = bestOf(input, capability, field)
    if (decided === null) continue
    const provider = memberById.get(decided.candidate.id)
    if (provider === undefined) continue
    const group = byProvider.get(provider.slaveId)
    // The step is recorded for the FIRST gap this worker won, which is the one their sentence is
    // about. A later gap they also cover is another capability on the same proposal, not another
    // decision -- and a rationale that re-explained itself per key would say the same thing twice.
    if (group === undefined) byProvider.set(provider.slaveId, { member: provider, covers: [capability], decided })
    else group.covers.push(capability)
    outstanding.delete(capability)
  }

  for (const { member, covers, decided } of byProvider.values()) {
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
        `granting ${roles.length === 1 ? 'it' : 'them'} makes them dispatchable for this work with nobody new.` +
        // M53 R8: WHY this one and not the other candidate, in the ranker's own words. Absent when
        // there was no other candidate, and absent when nothing but the names separated them --
        // "we picked alphabetically" is not a reason worth putting in front of a person (D26).
        (decided.decidedBy === null || decided.decidedBy === 'identity' ? '' : ` ${decided.reason}`),
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
    rankBreakFor(input, 'company_slave'),
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
    rankBreakFor(input, 'template'),
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
  rankBreak: (challenger: Candidate, holder: Candidate) => boolean,
): void {
  while (outstanding.size > 0) {
    let best: Candidate | null = null
    for (const candidate of candidates) {
      const covers = [...outstanding].filter((capability) => candidate.capabilities.includes(capability)).toSorted()
      if (covers.length === 0) continue
      const challenger = { ...candidate, covers }
      if (best === null || beats(challenger, best, rankBreak)) best = challenger
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
 *  unconditionally. The FIFTH, underneath them, used to be the id and is now the record, the
 *  preference and the cost (M53 R8, plan decision D25) -- with the id still the last word inside it,
 *  so a field the ranker cannot separate breaks exactly where it always did. */
function beats(
  challenger: Candidate,
  holder: Candidate,
  rankBreak: (challenger: Candidate, holder: Candidate) => boolean,
): boolean {
  if (challenger.covers.length !== holder.covers.length) return challenger.covers.length > holder.covers.length
  if (challenger.recommended !== holder.recommended) return challenger.recommended
  if (challenger.capabilities.length !== holder.capabilities.length) {
    return challenger.capabilities.length < holder.capabilities.length
  }
  if (challenger.name !== holder.name) return challenger.name.localeCompare(holder.name) < 0
  return rankBreak(challenger, holder)
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
