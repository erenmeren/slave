import {
  listCapabilities,
  listDecisions,
  listOrganization,
  loadSupervisorWorld,
  type DecisionView,
} from '@slave-of-ai/control'
import {
  capabilityIndex,
  isStaffableTask,
  teamPlanOf,
  type CapabilityRecord,
  type SupervisorWorld,
} from '@slave-of-ai/domain'

/** One worker, as the Organization view reads them (R6): who, how they got here, what they
 *  provide, and what they are doing right now. */
export interface OrganizationRow {
  readonly slaveId: string
  readonly name: string
  readonly roleLabel: string
  /** `company` when the worker came off a company roster, `project` otherwise. The PERMANENT /
   *  PROJECT / TEMPORARY lifecycle is M50's; this is the only distinction the schema can honestly
   *  make today, and it is the same one `ProjectBrief.team[].company` makes. */
  readonly kind: 'company' | 'project'
  readonly capabilities: readonly { readonly key: string; readonly label: string }[]
  /** WHY this worker is on this project, in one sentence -- the milestone's "why selected". The
   *  stored `selectionRationale` when there is one, else the fact the row can support. */
  readonly why: string
  readonly runtimeRoles: readonly string[]
  readonly doing: string | null
}

export interface OrganizationNeed {
  readonly capability: string
  readonly label: string
  readonly summary: string
  readonly readyTasks: number
  /** The `pending` decisions about THIS capability -- rendered as `ProposalRow`s, so a proposal
   *  reads and is answered here exactly as it is on the Overview (M45's rule). */
  readonly decisions: readonly DecisionView[]
}

export interface OrganizationView {
  readonly workers: readonly OrganizationRow[]
  readonly needs: readonly OrganizationNeed[]
  readonly covered: readonly { readonly capability: string; readonly label: string; readonly by: string }[]
  readonly unfillable: readonly { readonly capability: string; readonly label: string }[]
  readonly hints: readonly {
    readonly slaveId: string
    readonly text: string
    readonly targetTemplateName: string | null
    readonly capability: string | null
    /** The words for {@link capability}, carried beside it rather than resolved on the page: the
     *  key stays for `title` and `data-`, and a surface prints the label (`docs/ia.md` rule 3).
     *  Null exactly when `capability` is -- most handoff sentences name a role, not a key. */
    readonly capabilityLabel: string | null
  }[]
  /**
   * How many `pending` staffing proposals this page is NOT showing (fix round 1, minor 4).
   *
   * A proposal is recorded against a capability, and by the time a human reaches it somebody may
   * have been given the role that covers it -- the gap is gone, no need row carries the proposal,
   * and it is still waiting on a person on the Overview. A count, not the rows: answering it
   * belongs where the decision queue lives, and a second Approve here would be a second place to
   * keep in step.
   */
  readonly pendingElsewhere: number
  readonly taskTitles: Readonly<Record<string, string>>
}

/**
 * The Organization tab's whole read (R6).
 *
 * The coverage summary comes from `teamPlanOf` -- the SAME function `candidates` builds its offers
 * from -- rather than from a second reading of "what is missing" here: two computations of that
 * question would eventually disagree in front of a person, and the one on the page would be the
 * one nobody could act on.
 */
export async function buildOrganization(workspaceId: string, now: Date = new Date()): Promise<OrganizationView | null> {
  const org = await listOrganization(workspaceId)
  // A missing workspace is this builder's ONE null, and it has to be decided here: the world
  // loader below opens a `RepeatableRead` transaction and THROWS on a workspace that is not there
  // (right for a tick, wrong for a route, which owes its caller a 404).
  if (!org.ok) return null
  const taxonomy = await listCapabilities()
  // The check above and the loader below are two reads, and a project can be deleted between them
  // (fix round 1, minor 5). That is a 404 as much as the check's own refusal is -- but ONLY that
  // one error: anything else is a failure this route must not dress up as "no such project".
  let world
  try {
    world = (await loadSupervisorWorld(workspaceId, now)).world
  } catch (cause) {
    if (!isRecordNotFound(cause)) throw cause
    return null
  }
  const plan = teamPlanOf(world)
  const pending = await listDecisions(workspaceId, { pending: true })
  const taskTitles = Object.fromEntries(world.tasks.map((task) => [task.id, task.title] as const))

  // ONE index for the whole render (M47 t1 review, carried): `capabilityLabel` builds a fresh Map
  // out of the taxonomy on every call, and this view labels a chip per capability per worker plus
  // every need, every covered row and every unfillable one.
  const label = labeller(taxonomy)

  /**
   * The gaps, off the PLAN and nothing else (fix round 1, Critical).
   *
   * `formTeam` splits what the board's ready and blocked work asks for into three: covered,
   * proposed, and unfillable -- so the proposals' `covers` IS the set of gaps somebody can fill,
   * with no second reading of "what is missing" to disagree with it. The round-1 version added
   * every task's `requiredCapabilities` on top of that, over EVERY status, and a `done` task's
   * capability then rendered as "nobody can be dispatched for API design" with no proposal under
   * it while the worker holding that role sat two rows above (D5: one computation, one answer).
   *
   * `covers`, not `proposal.capability`: one pick may close several gaps at once, and `capability`
   * is only the first of them -- the rest are gaps a person still has to see.
   */
  const needs = plan.proposals
    .flatMap((proposal) => proposal.covers)
    .filter((capability, index, all) => all.indexOf(capability) === index)
    .toSorted()
    .map((capability) => {
      const decisions = pending.filter(
        (decision) => decision.situationKind === 'capability_unstaffed' && decision.subjectId === capability,
      )
      return {
        capability,
        label: label(capability),
        summary:
          decisions[0]?.situation.summary ?? `Nobody on this project can be dispatched for ${label(capability)}.`,
        // `isStaffableTask`, the SAME predicate the situation raised the gap with (final review,
        // Important 2). This count read `status === 'ready'` alone, so a ready task whose
        // dependency had not been integrated was counted here and not there -- the page said "2
        // ready tasks" under a summary that said one.
        readyTasks: world.tasks.filter(
          (task) => isStaffableTask(task) && task.requiredCapabilities.includes(capability),
        ).length,
        decisions,
      }
    })

  const shown = new Set(needs.map((need) => need.capability))

  return {
    workers: org.value.workers.map((worker) => ({
      slaveId: worker.slaveId,
      name: worker.name,
      roleLabel: worker.role,
      kind: worker.kind,
      capabilities: worker.capabilities.map((key) => ({ key, label: label(key) })),
      why: whyHere(worker),
      runtimeRoles: worker.runtimeRoles,
      doing: doingNow(worker.slaveId, world),
    })),
    needs,
    covered: plan.covered.map((one) => ({ capability: one.capability, label: label(one.capability), by: one.by })),
    unfillable: plan.unfillable.map((capability) => ({ capability, label: label(capability) })),
    hints: org.value.hints.map((hint) => ({
      ...hint,
      capabilityLabel: hint.capability === null ? null : label(hint.capability),
    })),
    pendingElsewhere: pending.filter(
      (decision) => decision.situationKind === 'capability_unstaffed' && !shown.has(decision.subjectId),
    ).length,
    taskTitles,
  }
}

/** Prisma's "a record this operation depended on was not found" (`P2025`), which is what
 *  `findUniqueOrThrow` inside the world loader's transaction raises for a workspace that has been
 *  deleted. Read off the code rather than the message: the message is prose and is translated by
 *  nothing, but it is also not a contract. */
function isRecordNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'P2025'
}

/** `capabilityLabel`'s answer, over ONE index built once. The key itself is the fallback, exactly
 *  as the domain's own helper has it: a row written by a newer build can carry a key this
 *  bundle's taxonomy has never heard of, and the key is the honest thing to show. */
function labeller(taxonomy: readonly CapabilityRecord[]): (key: string) => string {
  const index = capabilityIndex(taxonomy)
  return (key) => index.get(key)?.label ?? key
}

/** The sentence in the "why here" column, in the order of how much it actually says: the
 *  Supervisor's own rationale, then the company it was assigned from, then the honest fallback for
 *  a worker that predates all of this. Never a guess. */
function whyHere(worker: {
  readonly selectionRationale: string | null
  readonly kind: 'company' | 'project'
  readonly companyName: string | null
}): string {
  if (worker.selectionRationale !== null && worker.selectionRationale !== '') return worker.selectionRationale
  if (worker.kind === 'company' && worker.companyName !== null) return `Assigned from ${worker.companyName}`
  return 'Seeded'
}

/**
 * What the worker is doing NOW, read off the world the rest of this view came from -- so the page
 * cannot show a worker as free on a board that says otherwise.
 *
 * `SupervisorSlave` says busy but not WHICH task, and the task TITLE belongs to the Tasks tab:
 * joining a run to a title here would be a second source of truth about what a worker is doing.
 * The state is the honest answer, and `null` is "idle".
 */
function doingNow(slaveId: string, world: SupervisorWorld): string | null {
  const slave = world.slaves.find((one) => one.id === slaveId)
  return slave === undefined || !slave.busy ? null : 'Working'
}
