import { listRunbooks, loadSupervisorWorld, runbookStatus } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  actionSchema,
  capabilityIndex,
  recommendRunbooks,
  teamPlanOf,
  type CapabilityRecord,
  type Runbook,
} from '@slave-of-ai/domain'

/** One runbook, as a picker row and as a recommendation. Keys never reach the page (`docs/ia.md`
 *  rule 3) except as the machine handle on `data-key`. */
export interface RunbookOption {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly stageCount: number
  readonly source: 'seed' | 'persona' | 'human'
  /** Present on a recommendation only: the sentence the rules wrote, which is the same sentence a
   *  pending `adopt_runbook` decision carries. */
  readonly why: string | null
}

export interface RunbookStageView {
  readonly key: string
  readonly title: string
  readonly objective: string
  readonly state: 'done' | 'active' | 'pending' | 'missing'
  readonly taskCount: number
  readonly capabilities: readonly { readonly key: string; readonly label: string; readonly covered: boolean }[]
}

export interface RunbookPanelView {
  readonly adopted: RunbookOption | null
  readonly currentStage: string | null
  readonly stages: readonly RunbookStageView[]
  readonly recommendations: readonly RunbookOption[]
  readonly all: readonly RunbookOption[]
  /**
   * The `pending` `adopt_runbook` proposal for this workspace, if the Supervisor has made one --
   * its id AND the runbook it is about (fix round 1, Critical).
   *
   * The KEY is the load-bearing half. A click adopts what the person clicked: it goes through the
   * DECISION only when the clicked key IS the proposed one (approving is what they are being asked
   * for, and adopting behind the proposal's back would leave it pending forever), and adopts by
   * hand otherwise. An id alone made every click an approval of whatever the Supervisor happened to
   * have proposed.
   *
   * `name` rides along because the panel's note names the proposal in words and a key may never be
   * visible text (`docs/ia.md` rule 3); it is the name the DECISION was made with, which is the
   * text the person is being asked about. Null when no proposal waits -- and also when the stored
   * action cannot be read as an `adopt_runbook` one, which is the same thing to this panel: there
   * is no key to compare a click against, so every click adopts by hand.
   */
  readonly pendingDecision: { readonly id: string; readonly key: string; readonly name: string } | null
}

/**
 * The Overview's runbook panel (M48 R7).
 *
 * ONE derivation for both halves of the panel, and both halves come from functions a decision was
 * made from: `recommendRunbooks` is what `observe` raises `runbook_recommended` with, and
 * `runbookStatus` is what `runbook-status` prints. Two computations of "which runbook fits" or "what
 * stage is this project on" would eventually disagree in front of a person -- and the one a person
 * could act on would be the other one.
 *
 * The four stage STATES are `runbookStatus`' own (`done` / `active` / `pending` / `missing`), read
 * and never re-derived here: that ladder asks where the WORK is before it asks what each stage
 * holds, and a second reading off the task counts is exactly how "current stage: Design" came to sit
 * above a row saying Design had been skipped (M48 t2 fix round 1).
 */
export async function buildRunbookPanel(workspaceId: string): Promise<RunbookPanelView | null> {
  // Only to tell "no such project" from "a project with nothing to say": every other fact this
  // builder needs comes off the world snapshot below.
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  // The one null this builder has, decided HERE: the world loader below opens a transaction whose
  // `findUniqueOrThrow` raises for a missing workspace (right for a tick, wrong for a route, which
  // owes its caller a 404) -- `buildOrganization`'s own rule.
  if (workspace === null) return null

  const [all, status, { world }, pending] = await Promise.all([
    listRunbooks(),
    runbookStatus(workspaceId),
    loadSupervisorWorld(workspaceId, new Date()),
    // In the batch with the other three (fix round 1, minor 5): it depends on nothing any of them
    // returns, and a fourth round trip run in series would be one more wait on every stream-driven
    // refetch of the Overview.
    prisma.supervisorDecision.findFirst({
      where: { workspaceId, status: 'pending', situationKind: 'runbook_recommended' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, action: true },
    }),
  ])
  if (!status.ok) return null

  const rosterCapabilities = [...new Set(world.slaves.flatMap((slave) => slave.capabilities))]
  // THE SAME STATE, FROM THE SAME LIST, THE SUPERVISOR RECOMMENDS FROM (M48 final review, Minor 1;
  // D10 refined).
  //
  // `world.runbooks` is EMPTY unless the loader judged that `runbook_recommended` could fire for
  // this project at all -- a goal, no adopted runbook, AND AN EMPTY BOARD, which is the one moment
  // at which choosing a way of working changes what the next run is asked for. Read off that field
  // rather than re-spelt here, so the panel cannot come to recommend in a state the Supervisor is
  // silent in: it used to offer the same list over a board mid-flight, where adopting a runbook
  // re-plans nothing and every stage the plan already skipped is reported missing the instant it
  // lands. A project with tasks and no runbook gets the picker alone -- switching is still a thing
  // a person may do, the product simply stops suggesting it.
  //
  // It is also the list the OFFERS are built from (the loader drops a runbook whose stages nothing
  // can read, and bounds the scan), so the rows here are the rows a `runbook_recommended` decision
  // would carry, in the same order.
  const recommendations =
    world.goal === null || world.runbooks.length === 0
      ? []
      : recommendRunbooks(world.goal, world.runbooks, rosterCapabilities, world.taxonomy).map((recommendation) =>
          option(recommendation.runbook, recommendation.rationale),
        )

  // M47's own coverage reading, reused rather than re-derived: `teamPlanOf` is the function the
  // Organization page and `candidates` both answer "who covers what" from. The roster's own keys
  // join it because `teamPlanOf` only speaks about capabilities the BOARD asks for, and a stage
  // asks for capabilities no task may have been written for yet.
  const plan = teamPlanOf(world)
  const covered = new Set([...plan.covered.map((entry) => entry.capability), ...rosterCapabilities])

  // ONE index for the whole render (the M47 carry): `capabilityLabel` builds a fresh Map out of the
  // taxonomy per call, and this view labels a capability per stage of a runbook with up to twelve.
  //
  // THE WORLD'S taxonomy, not a `listCapabilities()` of this builder's own (M48 final review,
  // Important 1): the loader now reads the table whenever runbooks matter -- an adopted runbook or
  // a recommendation that could be made -- so the list is already in the snapshot this page is
  // built from, and a second query would be a second reading of one table that can only disagree
  // with the first. It is also the SAME taxonomy the Supervisor wrote its rationale with, which is
  // what keeps the sentence on the timeline and the chips on this panel naming one capability the
  // same way.
  const label = labeller(world.taxonomy)

  const stageByKey = new Map((status.value.runbook?.stages ?? []).map((stage) => [stage.key, stage] as const))

  return {
    adopted: status.value.runbook === null ? null : option(status.value.runbook, null),
    currentStage: status.value.currentStage,
    stages: status.value.stages.map((stage) => {
      const source = stageByKey.get(stage.key)
      return {
        key: stage.key,
        title: stage.title,
        objective: source?.objective ?? '',
        state: stage.state,
        taskCount: stage.taskCount,
        capabilities: (source?.capabilities ?? []).map((key) => ({
          key,
          label: label(key),
          covered: covered.has(key),
        })),
      }
    }),
    recommendations,
    all: all.map((runbook) => option(runbook, null)),
    pendingDecision: proposalOf(pending),
  }
}

/**
 * The waiting proposal, as the panel can act on it: its id and the runbook it names.
 *
 * `safeParse` and not `parsedOrThrow`: the Overview must render for a project whose decision row
 * carries an action a newer build wrote, and "I cannot read which runbook was proposed" is not a
 * page failure -- it is a click that adopts by hand while the decision waits for the timeline.
 */
function proposalOf(
  row: { readonly id: string; readonly action: unknown } | null,
): { readonly id: string; readonly key: string; readonly name: string } | null {
  if (row === null) return null
  const action = actionSchema.safeParse(row.action)
  if (!action.success || action.data.kind !== 'adopt_runbook') return null
  return { id: row.id, key: action.data.key, name: action.data.name }
}

/** A runbook as the panel's one row shape. `why` is the recommendation's sentence and null
 *  everywhere else -- a picker row has no reason to offer, and inventing one would be a rule
 *  nobody wrote. */
function option(runbook: Runbook, why: string | null): RunbookOption {
  return {
    key: runbook.key,
    name: runbook.name,
    description: runbook.description,
    stageCount: runbook.stages.length,
    source: runbook.source,
    why,
  }
}

/** `capabilityLabel`'s answer over ONE index, with the key itself as the fallback -- `server/
 *  organization.ts`'s own helper, for its own reason: a stage written by a newer build can name a
 *  key this bundle's taxonomy has never heard of. */
function labeller(taxonomy: readonly CapabilityRecord[]): (key: string) => string {
  const index = capabilityIndex(taxonomy)
  return (key) => index.get(key)?.label ?? key
}
