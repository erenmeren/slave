import { prisma } from '@slave-of-ai/db/client'
import {
  NON_TERMINAL_RUN_STATUSES,
  TERMINAL,
  parseHandoffContract,
  parseRunbookStages,
  type HandoffContract,
  type RunStatus,
  type TaskStatus,
} from '@slave-of-ai/domain'
import { artifactLabel } from '../lib/artifactLabel'
import { buildShellFacts, type ShellFacts } from './shell'

/**
 * `SlaveRun.kind`, spelled as a union rather than imported (M51 R7): the generated `RunKind` lives
 * in `@slave-of-ai/db`, whose barrel is a server module, and this DTO is rendered by a client
 * component. Three members, the same three the schema has.
 */
export type TaskRunKind = 'implementation' | 'review' | 'planning'

export interface TaskRunSummary {
  readonly id: string
  readonly status: RunStatus
  /** WHICH kind of run this is (M51 R7). The drawer's `retried work` counts implementation runs
   *  only: a review run is not a retry of the implementation, and folding one in would make
   *  "what did getting this wrong cost" answer a different question (decision D20). */
  readonly kind: TaskRunKind
  /** USD, or `null` when this run's runtime reported no spend (M12 Task 9 -- spec Decision 6). */
  readonly costUsd: number | null
  /**
   * What it takes to ESTIMATE a run that reported nothing (M51 R5): the folded input figure, the
   * output figure, and the model half of the pair the run was dispatched with. All three are null
   * on a run recorded before M51 and on a runtime that reports no usage at all -- which is exactly
   * `costProvenanceOf`'s `unmeasured`, and the panel prints `—` for it rather than a zero.
   */
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly model: string | null
  /**
   * `SlaveRun.provider` -- the runtime that actually ran this, or `null` for a run that never
   * spawned one.
   *
   * Here so a run row IS a `CostRow` (`packages/domain/src/guardrails/spend.ts`) and the panel can
   * ask the domain where a figure came from rather than restating that rule in a component. It is
   * also the column `sumSpend` discriminates an unmeasured run on, so the two readings of "nobody
   * measured this" stay the same reading.
   */
  readonly provider: string | null
  readonly toolCalls: number
  /**
   * This run's OWN tool-call ceiling (M51 R7, decision D16), or `null` when the workspace's
   * `maxToolCallsPerRun` is the only limit on it.
   *
   * Non-null means the behavioural breaker constrained this run, and the cap STANDS even after the
   * breaker's word de-escalates -- nothing clears it before the run ends. So the one line that
   * shows a run's tool calls says which ceiling it is counting against, rather than leaving a
   * capped run looking like an ordinary one.
   */
  readonly toolCallCap: number | null
  readonly startedAt: string
  readonly endedAt: string | null
  /** M23 B4: null once collected. */
  readonly worktreePath: string | null
  readonly checkpoint: {
    readonly pausedAtStep: number | null
    readonly sessionId: string
    readonly dirtyFileCount: number
    /**
     * The pause gate's `Checkpoint.deniedToolUseIds` (M15), one entry per denied tool use.
     * `summary` is always `null` today -- a MEASURED limit, not a TODO: `run.tool_call` event
     * payloads carry only `{ name, summary }` (`packages/domain/src/events/schema.ts`,
     * `apps/orchestrator/src/pump.ts`'s `tool_call` case) with no `tool_use_id`, so there is no
     * field to join a denied id back to the event that named it. Inventing a join (e.g. matching
     * by ordinal position or nearest `seq`) would assert a correspondence the data does not
     * support, so this stays an honest `null` and `TaskDetailPanel` falls back to the truncated
     * id. A future task that adds `toolUseId` to the event payload can populate this for real.
     */
    readonly deniedDuringPause: readonly { readonly id: string; readonly summary: string | null }[]
  } | null
  /**
   * Who this run is waiting on an answer from (M36 t3), or `null` when it is not waiting.
   *
   * Read off the RUN's own pause category (`waiting_for_answer`), not off the presence of a
   * message: the run saying it is waiting is the fact, and a missing message row must not turn a
   * waiting run back into an ordinary paused one -- the same rule `overview.ts`'s `waitingFor`
   * follows. The panel renders "waiting for X" instead of "paused at step N", because that pause
   * is not one a human is being asked to end.
   */
  readonly waitingFor: string | null
}

export interface TaskArtifactSummary {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly createdAt: string
}

export interface TaskBoardItem {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly status: TaskStatus
  readonly priority: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly assigneeName: string | null
  readonly branch: string | null
  readonly lastRejectionReason: string | null
  /**
   * Which goal version this task was derived from (M40 §1), or `null` for a task a human made by
   * hand -- no plan produced it, so there is no requirement for it to be behind. Rendered as
   * `goal vN` (or "unstamped") on the card and the detail panel, and compared against
   * `workspace.goalVersion` for the **stale** badge.
   */
  readonly goalVersion: number | null
  /**
   * M35 t2: null until the task's work actually reached the base branch -- `merge.ts`'s
   * real-merge path stamps it, its `!autoMerge` path (done, no merge, branch left for a human)
   * leaves it null. ISO string, same convention as every other timestamp on this DTO.
   */
  readonly integratedAt: string | null
  readonly runs: readonly TaskRunSummary[]
  /**
   * M23 B4 (controller ruling): computed server-side so the panel never imports `TERMINAL` from
   * `@slave-of-ai/domain` itself -- a terminal task with at least one run that still has a
   * worktree on disk to remove.
   */
  readonly collectable: boolean
  /** M23 C1: the verify logs `apps/orchestrator/src/verify.ts` wrote for this task, newest first. */
  readonly artifacts: readonly TaskArtifactSummary[]
  /**
   * M48 R1: the typed handoff, parsed server-side so the panel never imports a zod schema. Null
   * for a hand-made task, one planned before this milestone, or a column that will not parse --
   * all three mean "there is no contract to show", and none of them is a failure this panel can
   * do anything about.
   */
  readonly handoff: HandoffContract | null
  /** M48 R2: the runbook stage, rendered as a chip beside the goal stamp. Null for a task no
   *  runbook produced. The KEY -- what `title=` and `data-` carry. */
  readonly stage: string | null
  /**
   * That stage's TITLE off the adopted runbook (fix round 1, Important 2) -- what the chip actually
   * prints, because a key is never visible text (`docs/ia.md` rule 3).
   *
   * Null in three cases the panel says the same thing about: the task has no stage, the project has
   * adopted no runbook, or the adopted runbook does not list this stage (a task stamped by an
   * earlier runbook, or by a plan that invented a stage). "Unlisted stage" is the honest reading of
   * all three, and the key stays one hover away.
   */
  readonly stageTitle: string | null
}

export interface TasksSnapshot {
  readonly workspace: {
    readonly id: string
    readonly name: string
    readonly haltedReason: string | null
    /** The version of the goal this project is on (M40 §1) -- the other half of a card's **stale**
     *  badge, which is `task.goalVersion !== null && task.goalVersion < this`. 0 for a project with
     *  no recorded version, which nothing can be behind. */
    readonly goalVersion: number
  }
  readonly tasks: readonly TaskBoardItem[]
  /**
   * The same counts/guardrails the project header and the Tasks tab's badge show (M14 Task 8/10
   * controller ruling; M24 Task 2 moved them off the global shell's `<Sidebar>` onto the project
   * header/tabs): this route already streams the workspace `/w/:id/tasks` mounts, so
   * `TasksClient` publishes this to `hooks/useShellFacts.ts` on every snapshot rather than the
   * header/tabs opening a second `EventSource` against `/api/w/:id/shell` for the same workspace.
   */
  readonly shellFacts: ShellFacts
}

export async function buildTasksSnapshot(workspaceId: string): Promise<TasksSnapshot | null> {
  const [workspace, tasks, shellFacts] = await Promise.all([
    // The runbook comes off the workspace row this function already reads (fix round 1, Important
    // 2), not a second query: `Workspace.runbookId` is a relation, and its `stages` column is the
    // only place a stage key has a title.
    prisma.workspace.findUnique({ where: { id: workspaceId }, include: { runbook: { select: { stages: true } } } }),
    prisma.task.findMany({
      where: { workspaceId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: {
        runs: { orderBy: { startedAt: 'desc' }, include: { checkpoint: true, slave: true } },
        artifacts: { orderBy: { createdAt: 'desc' } },
      },
    }),
    buildShellFacts(workspaceId),
  ])
  if (workspace === null || shellFacts === null) return null

  // The waiting affordance (M36 t3): what each waiting run asked, and of whom. Two queries for the
  // whole board when anything is waiting -- usually nothing is -- and none at all otherwise. Same
  // shape as `overview.ts`'s own `waitingFor` lookup; kept here rather than shared because the two
  // walk different row sets (one live run per slave there, every run of every task here).
  const waitingRunIds = tasks
    .flatMap((task) => task.runs)
    .filter((run) => run.status === 'paused' && run.pauseReason === 'waiting_for_answer')
    .map((run) => run.id)
  const waitingFor = new Map<string, string>()
  if (waitingRunIds.length > 0) {
    const [questions, slaves] = await Promise.all([
      prisma.slaveMessage.findMany({
        where: { senderRunId: { in: waitingRunIds }, kind: 'question' },
        orderBy: { seq: 'desc' },
        select: { senderRunId: true, recipientSlaveId: true, recipientRole: true },
      }),
      prisma.slave.findMany({ where: { team: { workspaceId } }, select: { id: true, name: true } }),
    ])
    const nameById = new Map(slaves.map((slave) => [slave.id, slave.name]))
    for (const question of questions) {
      // Descending `seq`, so the first row seen for a run is its latest question: a run that asked,
      // was answered, resumed and asked again is waiting on the second one.
      if (question.senderRunId === null || waitingFor.has(question.senderRunId)) continue
      waitingFor.set(
        question.senderRunId,
        question.recipientSlaveId !== null
          ? (nameById.get(question.recipientSlaveId) ?? question.recipientSlaveId)
          : `anyone with the ${question.recipientRole ?? 'unknown'} role`,
      )
    }
  }

  // ONE parse for the whole board: `parseRunbookStages` validates a JSON column, and a task list
  // of thirty would otherwise re-validate it thirty times. A column that will not parse leaves the
  // map empty, which reads as "no title known" -- the same as no runbook at all.
  const stageTitles = new Map<string, string>()
  const stages = workspace.runbook === null ? null : parseRunbookStages(workspace.runbook.stages)
  if (stages !== null && stages.ok) {
    for (const stage of stages.value) stageTitles.set(stage.key, stage.title)
  }

  return {
    workspace: { id: workspace.id, name: workspace.name, haltedReason: workspace.haltedReason, goalVersion: workspace.goalVersion },
    shellFacts,
    tasks: tasks.map((task) => {
      const liveRun = task.runs.find((run) => (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status))
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        assigneeName: liveRun?.slave.name ?? null,
        branch: task.branch,
        lastRejectionReason: task.lastRejectionReason,
        goalVersion: task.goalVersion,
        integratedAt: task.integratedAt?.toISOString() ?? null,
        // M23 B4 (controller ruling): a terminal task with a worktree still standing on at least
        // one of its runs. Computed here, not in the panel -- the panel never imports `TERMINAL`
        // from `@slave-of-ai/domain`.
        collectable: TERMINAL.includes(task.status) && task.runs.some((run) => run.worktreePath !== null),
        handoff: handoffOf(task.handoff),
        stage: task.stage,
        stageTitle: task.stage === null ? null : (stageTitles.get(task.stage) ?? null),
        artifacts: task.artifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          label: artifactLabel(artifact.path),
          createdAt: artifact.createdAt.toISOString(),
        })),
        runs: task.runs.map((run) => ({
          id: run.id,
          status: run.status,
          kind: run.kind,
          // Passed through as `number | null` (M12 Task 9, ruling R3). The comment this replaces
          // chose `$0.00` to avoid "widening this DTO to a tri-state" -- widening it is exactly
          // what spec Decision 6 asks for, and `TaskDetailPanel` renders `—` for the null.
          costUsd: run.costUsd,
          // M51 R5: the three columns an estimate needs, straight off the row the `include` above
          // already loads in full -- a projection change and nothing more.
          tokensIn: run.tokensIn,
          tokensOut: run.tokensOut,
          model: run.model,
          provider: run.provider,
          toolCalls: run.toolCalls,
          toolCallCap: run.toolCallCap,
          startedAt: run.startedAt.toISOString(),
          endedAt: run.endedAt?.toISOString() ?? null,
          // M23 B4: null once collected.
          worktreePath: run.worktreePath,
          checkpoint:
            run.checkpoint === null
              ? null
              : {
                  pausedAtStep: run.pausedAtStep,
                  sessionId: run.checkpoint.sessionId,
                  dirtyFileCount: run.checkpoint.dirtyFiles.length,
                  // No extra query here (see the DTO field's own comment): `checkpoint: true`
                  // above already selects every `Checkpoint` column, so `deniedToolUseIds` needs
                  // no widening, and there is no `run.tool_call` field to join those ids against.
                  deniedDuringPause: run.checkpoint.deniedToolUseIds.map((id) => ({ id, summary: null })),
                },
          waitingFor:
            run.status === 'paused' && run.pauseReason === 'waiting_for_answer'
              ? (waitingFor.get(run.id) ?? 'another slave')
              : null,
        })),
      }
    }),
  }
}

/** A stored `Task.handoff` column as a contract, or null. A row that will not parse is null rather
 *  than a throw: the board must render for every task on it, and a malformed contract is a planner
 *  bug for `concludePlanning` to refuse by name -- not a reason this page cannot open. */
function handoffOf(value: unknown): HandoffContract | null {
  if (value === null || value === undefined) return null
  const parsed = parseHandoffContract(value)
  return parsed.ok ? parsed.value : null
}
