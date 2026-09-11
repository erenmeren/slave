import { capCodePoints, MEMORY_BODY_MAX, MEMORY_CAPABILITIES_MAX, MEMORY_TITLE_MAX } from './types.js'
import type { MemoryDraft } from './provenance.js'

/**
 * The four outcomes this organisation learns from (M49 R2), as flat typed inputs.
 *
 * A small typed input rather than the rows themselves: this rule is PURE and is what makes
 * "what becomes a memory" testable without a database, and the four hooks that call it live in
 * three different packages. Each arm carries exactly what its own promotion needs and nothing
 * else -- the caller does the reading, this decides the writing.
 */
export type PromotionInput =
  /** (a) An implementation run succeeded. Hooked in `verifyConcludedRun`, not `advance` (plan
   *  erratum E1): only there are the run, its slave and its task all in hand. */
  | {
      readonly kind: 'run_succeeded'
      readonly workspaceId: string
      readonly taskId: string
      readonly taskTitle: string
      readonly runId: string
      readonly slaveId: string
      /** The LAST `run.output` event's text -- what the worker finally said, not the whole
       *  transcript, which is the thing R1 exists to stop storing. */
      readonly finalText: string
      readonly lastOutputSeq: number | null
      readonly requiredCapabilities: readonly string[]
      readonly goalVersion: number | null
    }
  /** (b) `task.verify_passed`: the commands agreed. */
  | {
      readonly kind: 'verify_passed'
      readonly workspaceId: string
      readonly taskId: string
      readonly taskTitle: string
      readonly runId: string | null
      /** The handoff contract's `expectedOutput` when the task carries one -- what was supposed to
       *  exist, now proven to. */
      readonly expectedOutput: string | null
      readonly commands: readonly string[]
      readonly requiredCapabilities: readonly string[]
      readonly goalVersion: number | null
    }
  /** (c) A person approved or rejected a proposal. */
  | {
      readonly kind: 'decision_resolved'
      readonly workspaceId: string
      readonly decisionId: string
      readonly outcome: 'approved' | 'rejected'
      readonly rationale: string
      readonly reason: string | null
      readonly userId: string | null
      readonly taskId: string | null
      readonly goalVersion: number | null
    }
  /** (c) The goal itself moved. */
  | {
      readonly kind: 'goal_changed'
      readonly workspaceId: string
      readonly version: number
      readonly request: string | null
      readonly goal: string
      readonly userId: string | null
    }
  /** (d) A review or a verify turned the work down. */
  | {
      readonly kind: 'work_rejected'
      readonly workspaceId: string
      readonly taskId: string
      readonly taskTitle: string
      /** The worker that DID the work -- never the reviewer (plan erratum E2). Null when no
       *  implementation run is on record, and then there is nobody to teach. */
      readonly slaveId: string | null
      readonly runId: string | null
      readonly reason: string
      readonly by: 'review' | 'verification'
      readonly sourceRef: string | null
      readonly requiredCapabilities: readonly string[]
      readonly goalVersion: number | null
    }

const titleOf = (text: string): string => capCodePoints(text.trim(), MEMORY_TITLE_MAX)
const bodyOf = (text: string): string => capCodePoints(text.trim(), MEMORY_BODY_MAX)

/**
 * The task's capability keys, bounded by the same cap the schema enforces (M49 t1 fix round 1).
 *
 * A task may ask for more than {@link MEMORY_CAPABILITIES_MAX} keys, and copying the list whole
 * built a draft `memoryDraftSchema` then refused -- the same class of bug as a cap counted in two
 * different units. The FIRST twenty in the task's own order, so two runs over one task promote
 * the same keys; truncation is honest here because these are retrieval references, and a memory
 * that matches on nineteen of a task's keys is found by every read that would have wanted it.
 */
const capabilitiesOf = (keys: readonly string[]): string[] => keys.slice(0, MEMORY_CAPABILITIES_MAX)

/**
 * What this outcome should be remembered as, or `null` for "nothing worth keeping" (M49 R2).
 *
 * PROCEDURE and HYPOTHESIS are never produced here: a procedure is written by a person or
 * condensed out of a worker's lessons (R5), and a hypothesis nobody typed is a guess the system
 * would then hand to a run as knowledge.
 *
 * Null is a first-class answer and is returned for every outcome with nothing in it -- a run that
 * said nothing, a rejection with no reason, a verification with neither a contract nor a command
 * to name, the first version of a goal (there was nothing to change), a lesson with no worker to
 * belong to. A memory whose body is "" is worse than no memory: it reaches a prompt.
 */
export function promotionFor(input: PromotionInput): MemoryDraft | null {
  switch (input.kind) {
    case 'run_succeeded': {
      const body = bodyOf(input.finalText)
      if (body === '') return null
      return {
        type: 'observation',
        scope: 'workspace',
        companyId: null,
        workspaceId: input.workspaceId,
        slaveId: null,
        title: titleOf(`Task: ${input.taskTitle}`),
        body,
        // A CANDIDATE, and that is the whole of R2(a): a worker saying it did the thing is not the
        // thing being done. Only a passed verification promotes this to knowledge a run is given.
        status: 'candidate',
        confidence: 'interpretation',
        capabilities: capabilitiesOf(input.requiredCapabilities),
        verifiedBy: null,
        supersedesTaskCandidates: false,
        supersedesGoalDecisions: false,
        supersedesTaskFacts: false,
        provenance: {
          sourceKind: 'run_output',
          sourceRef: input.lastOutputSeq === null ? null : String(input.lastOutputSeq),
          createdBy: 'slave',
          createdByUserId: null,
          taskId: input.taskId,
          runId: input.runId,
          goalVersion: input.goalVersion,
        },
      }
    }
    case 'verify_passed': {
      const body = bodyOf(
        input.expectedOutput ??
          (input.commands.length === 0 ? '' : `${input.taskTitle} — verified by ${input.commands.join(', ')}`),
      )
      if (body === '') return null
      return {
        type: 'fact',
        scope: 'workspace',
        companyId: null,
        workspaceId: input.workspaceId,
        slaveId: null,
        title: titleOf(`Task: ${input.taskTitle}`),
        body,
        status: 'verified',
        confidence: 'sourced',
        capabilities: capabilitiesOf(input.requiredCapabilities),
        verifiedBy: 'verification',
        // R2(b): the observation this task's run left behind is now answered by something better.
        supersedesTaskCandidates: true,
        supersedesGoalDecisions: false,
        // Final review, Important 3: a task that came back from review and passed a SECOND time
        // wrote a second fact with the same words as the first. This one retires them.
        supersedesTaskFacts: true,
        provenance: {
          sourceKind: 'verification',
          sourceRef: input.runId,
          createdBy: 'system',
          createdByUserId: null,
          taskId: input.taskId,
          runId: input.runId,
          goalVersion: input.goalVersion,
        },
      }
    }
    case 'decision_resolved': {
      const rationale = input.rationale.trim()
      if (rationale === '') return null
      const word = input.outcome === 'approved' ? 'Approved' : 'Rejected'
      const reason = input.reason?.trim() ?? ''
      return {
        type: 'decision',
        scope: 'workspace',
        companyId: null,
        workspaceId: input.workspaceId,
        slaveId: null,
        title: titleOf(`${word}: ${rationale}`),
        body: bodyOf(reason === '' ? `${word}: ${rationale}` : `${word}: ${rationale} — ${reason}`),
        status: 'verified',
        confidence: 'sourced',
        capabilities: [],
        verifiedBy: 'human',
        supersedesTaskCandidates: false,
        supersedesGoalDecisions: false,
        supersedesTaskFacts: false,
        provenance: {
          sourceKind: 'decision',
          sourceRef: input.decisionId,
          createdBy: 'human',
          createdByUserId: input.userId,
          taskId: input.taskId,
          runId: null,
          goalVersion: input.goalVersion,
        },
      }
    }
    case 'goal_changed': {
      // v1 is the goal being SET, not changed: there is no decision in it, and the goal itself is
      // already the first section of every planning prompt.
      if (input.version < 2) return null
      const body = bodyOf(input.request ?? input.goal)
      if (body === '') return null
      return {
        type: 'decision',
        scope: 'workspace',
        companyId: null,
        workspaceId: input.workspaceId,
        slaveId: null,
        title: `Goal v${String(input.version)}`,
        body,
        status: 'verified',
        confidence: 'sourced',
        capabilities: [],
        verifiedBy: 'human',
        supersedesTaskCandidates: false,
        // Final review, Important 1: the NEWEST goal is the goal. Every version used to stay
        // verified for ever, and a project on v14 handed a run fourteen decisions of the
        // highest-ranking type with nothing else fitting beside them.
        supersedesGoalDecisions: true,
        supersedesTaskFacts: false,
        provenance: {
          sourceKind: 'goal',
          sourceRef: String(input.version),
          createdBy: 'human',
          createdByUserId: input.userId,
          taskId: null,
          runId: null,
          goalVersion: input.version,
        },
      }
    }
    case 'work_rejected': {
      // Plan erratum E2: a lesson belongs to somebody. With no implementation run on record there
      // is no worker to teach, and a project-scoped copy of a rejection is just the rejection.
      if (input.slaveId === null) return null
      const body = bodyOf(input.reason)
      if (body === '') return null
      return {
        type: 'lesson',
        scope: 'worker',
        companyId: null,
        workspaceId: null,
        slaveId: input.slaveId,
        title: titleOf(`Rework on ${input.taskTitle}`),
        body,
        status: 'verified',
        confidence: 'sourced',
        capabilities: capabilitiesOf(input.requiredCapabilities),
        verifiedBy: input.by,
        supersedesTaskCandidates: false,
        supersedesGoalDecisions: false,
        supersedesTaskFacts: false,
        provenance: {
          sourceKind: input.by,
          sourceRef: input.sourceRef,
          createdBy: 'system',
          createdByUserId: null,
          taskId: input.taskId,
          runId: input.runId,
          goalVersion: input.goalVersion,
        },
      }
    }
  }
}
