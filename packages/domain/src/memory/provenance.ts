import { z } from 'zod'
import { err, ok, type Result } from '../result.js'
import {
  MEMORY_BODY_MAX,
  MEMORY_CAPABILITIES_MAX,
  MEMORY_CONFIDENCES,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  MEMORY_SOURCE_KIND_LABEL,
  MEMORY_STATUSES,
  MEMORY_TITLE_MAX,
  MEMORY_TYPES,
  MEMORY_TYPE_LABEL,
  MEMORY_VERIFIERS,
  MEMORY_VERIFIER_LABEL,
  type MemoryConfidence,
  type MemoryScope,
  type MemorySourceKind,
  type MemoryStatus,
  type MemoryType,
  type MemoryVerifier,
} from './types.js'

/**
 * Where one memory came from (M49 R1). Seven fields, and every one of them is a question somebody
 * reading a memory months later asks: what produced it, which exact thing, who was acting, which
 * person, which task, which run, and which version of the goal was standing at the time.
 *
 * `sourceRef` is TEXT for all seven source kinds -- an event seq, a decision id, a goal version, a
 * run id -- because it is a pointer a human follows, never a foreign key. Making it a real
 * relation would mean seven nullable columns and a table that cannot record a source its own
 * schema has not learnt about yet.
 */
export interface MemoryProvenance {
  readonly sourceKind: MemorySourceKind
  readonly sourceRef: string | null
  /** The `Actor` that caused it -- a person, a worker, or the pipeline itself. */
  readonly createdBy: 'human' | 'slave' | 'system'
  readonly createdByUserId: string | null
  readonly taskId: string | null
  readonly runId: string | null
  readonly goalVersion: number | null
}

/**
 * One memory as every reader sees it: no `Date` objects (ISO strings throughout, so a view
 * survives a route, a CLI and a fixture unchanged) and no Prisma types.
 */
export interface MemoryView {
  readonly id: string
  readonly type: MemoryType
  readonly scope: MemoryScope
  readonly companyId: string | null
  readonly workspaceId: string | null
  readonly slaveId: string | null
  readonly title: string
  readonly body: string
  readonly status: MemoryStatus
  readonly confidence: MemoryConfidence
  /** Retrieval references -- taxonomy keys, so a run asking for `security.application` can be
   *  given what this organisation knows about it. NOT validated against the taxonomy here: a key
   *  that is not a row simply never matches (M47 R1's own rule). */
  readonly capabilities: readonly string[]
  readonly verifiedAt: string | null
  readonly verifiedBy: MemoryVerifier | null
  readonly supersededById: string | null
  readonly removedReason: string | null
  /**
   * The memories this one SUMMARISES (R5), from the `MemorySource` join -- empty for every memory
   * that is not a condensation.
   *
   * On the view rather than left in the table (plan erratum E4) because {@link retrieveMemories}
   * is pure and R3 excludes the sources of an included summary: without this field that rule has
   * nothing to read.
   */
  readonly sourceIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly provenance: MemoryProvenance
}

/**
 * What a writer hands {@link recordMemory} -- a memory minus the four things only the database can
 * answer (`id`, `createdAt`, `updatedAt`, `sourceIds`) and minus `supersededById`/`removedReason`,
 * which are moves made LATER and never at birth.
 */
export interface MemoryDraft {
  readonly type: MemoryType
  readonly scope: MemoryScope
  readonly companyId: string | null
  readonly workspaceId: string | null
  readonly slaveId: string | null
  readonly title: string
  readonly body: string
  readonly status: MemoryStatus
  readonly confidence: MemoryConfidence
  readonly capabilities: readonly string[]
  readonly verifiedBy: MemoryVerifier | null
  /**
   * R2(b), carried from the pure rule to the one transaction that can act on it (plan decision
   * D3): this memory RETIRES the open OBSERVATION candidates of `provenance.taskId`. True only on
   * the fact a passed verification produces; a rule inferred from `sourceKind` inside control
   * would be a second place the promotion policy lived.
   */
  readonly supersedesTaskCandidates: boolean
  /**
   * Final review, Important 1, carried the same way: this DECISION retires the workspace's earlier
   * goal decisions -- the rows whose `provenance.sourceKind` is `goal`. True only on the decision a
   * goal CHANGE produces.
   *
   * Every version of the goal used to stay verified for ever, so a project on v14 offered a run
   * fourteen decisions of the highest-ranking type and its facts never reached the prompt. The
   * newest goal is the goal; the ones before it are history, and history is what `superseded` is.
   */
  readonly supersedesGoalDecisions: boolean
  /**
   * Final review, Important 3: this FACT retires the earlier VERIFICATION facts of
   * `provenance.taskId`. True only on the fact a passed verification produces.
   *
   * A task that came back from review and passed a second time wrote a second fact with the same
   * words as the first, and a run was then given the same sentence twice. The chain is preserved
   * rather than deduplicated: what the first verification proved is still readable, and still
   * points at what replaced it.
   */
  readonly supersedesTaskFacts: boolean
  readonly provenance: MemoryProvenance
}

const provenanceSchema = z
  .object({
    sourceKind: z.enum(MEMORY_SOURCE_KINDS),
    sourceRef: z.string().min(1).nullable(),
    createdBy: z.enum(['human', 'slave', 'system']),
    createdByUserId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
    goalVersion: z.number().int().nonnegative().nullable(),
  })
  .strict()

/**
 * A length check in CODE POINTS, which is the unit R1's caps are stated in and the unit
 * {@link capCodePoints} counts (M49 t1 fix round 1).
 *
 * Zod's own `.max()` counts UTF-16 UNITS, and the two disagree on exactly the text this system
 * produces most: a body `capCodePoints` has just trimmed to `MEMORY_BODY_MAX` code points is
 * `MEMORY_BODY_MAX + 1` units long whenever the cap lands on an astral character, so `.max()`
 * refused a draft `promotionFor` had built to the cap -- and a refused draft is a promotion that
 * silently never happens. One rule, one unit, both ends.
 */
const withinCodePoints = (max: number): z.ZodEffects<z.ZodString, string, string> =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => [...value].length <= max, { message: `at most ${String(max)} code points` })

const title = withinCodePoints(MEMORY_TITLE_MAX)
const body = withinCodePoints(MEMORY_BODY_MAX)
const capabilities = z.array(z.string().min(1)).max(MEMORY_CAPABILITIES_MAX)

/**
 * "Exactly one target, and it is the one the scope names" (R1), enforced HERE and not by a database
 * CHECK (plan decision D1): Prisma's PSL cannot express a check constraint, and this milestone's
 * migration has to survive `prisma migrate diff … -> "No difference detected"`.
 */
const targetRule = (
  value: {
    scope: MemoryScope
    companyId: string | null
    workspaceId: string | null
    slaveId: string | null
  },
  ctx: z.RefinementCtx,
): void => {
  const targets = [value.companyId, value.workspaceId, value.slaveId].filter((one) => one !== null)
  if (targets.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a memory names exactly one of companyId, workspaceId, slaveId',
    })
    return
  }
  const expected: Record<MemoryScope, string | null> = {
    company: value.companyId,
    workspace: value.workspaceId,
    worker: value.slaveId,
  }
  if (expected[value.scope] === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a ${value.scope} memory must name its own target` })
  }
}

export const memoryDraftSchema: z.ZodType<MemoryDraft, z.ZodTypeDef, unknown> = z
  .object({
    type: z.enum(MEMORY_TYPES),
    scope: z.enum(MEMORY_SCOPES),
    companyId: z.string().min(1).nullable(),
    workspaceId: z.string().min(1).nullable(),
    slaveId: z.string().min(1).nullable(),
    title,
    body,
    status: z.enum(MEMORY_STATUSES),
    confidence: z.enum(MEMORY_CONFIDENCES),
    capabilities,
    verifiedBy: z.enum(MEMORY_VERIFIERS).nullable(),
    supersedesTaskCandidates: z.boolean(),
    supersedesGoalDecisions: z.boolean(),
    supersedesTaskFacts: z.boolean(),
    provenance: provenanceSchema,
  })
  .strict()
  .superRefine(targetRule)

/** Validates a stored row read back (a route, the CLI, a gate), the way `runContextManifestSchema`
 *  validates a stored manifest. WRITE-strict, and there is no history to be READ-tolerant of --
 *  this table is born in M49. */
export const memorySchema: z.ZodType<MemoryView, z.ZodTypeDef, unknown> = z
  .object({
    id: z.string().min(1),
    type: z.enum(MEMORY_TYPES),
    scope: z.enum(MEMORY_SCOPES),
    companyId: z.string().min(1).nullable(),
    workspaceId: z.string().min(1).nullable(),
    slaveId: z.string().min(1).nullable(),
    title,
    body,
    status: z.enum(MEMORY_STATUSES),
    confidence: z.enum(MEMORY_CONFIDENCES),
    capabilities,
    verifiedAt: z.string().datetime().nullable(),
    verifiedBy: z.enum(MEMORY_VERIFIERS).nullable(),
    supersededById: z.string().min(1).nullable(),
    removedReason: z.string().min(1).nullable(),
    sourceIds: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    provenance: provenanceSchema,
  })
  .strict()
  .superRefine(targetRule)

export function parseMemoryDraft(value: unknown): Result<MemoryDraft, string> {
  const parsed = memoryDraftSchema.safeParse(value)
  return parsed.success ? ok(parsed.data) : err(parsed.error.message)
}

export function parseMemory(value: unknown): Result<MemoryView, string> {
  const parsed = memorySchema.safeParse(value)
  return parsed.success ? ok(parsed.data) : err(parsed.error.message)
}

/** The first 7 characters of an id -- `runContextSummary`'s own shortest-unambiguous convention,
 *  one shorter because a run reference reads beside a goal version. */
const short = (value: string): string => value.slice(0, 7)

/**
 * The bracket a memory wears inside a PROMPT (R3): what kind of thing it is, who said it is true,
 * and which task it came out of. Labels, never keys -- a model reads this too, and `run_output` in
 * a prompt is an identifier nobody has explained.
 */
export function memoryStamp(memory: MemoryView, taskTitle: string | null): string {
  const parts = [MEMORY_TYPE_LABEL[memory.type]]
  if (memory.verifiedBy !== null) parts.push(`verified by ${MEMORY_VERIFIER_LABEL[memory.verifiedBy]}`)
  if (taskTitle !== null) parts.push(`task ${taskTitle}`)
  else if (memory.provenance.taskId !== null) parts.push(`task ${short(memory.provenance.taskId)}`)
  return parts.join(' · ')
}

/**
 * The sentence the Knowledge page prints under a row (R6): where this came from, in the words a
 * person uses. The raw values stay in `title`/`data-` attributes on the page -- this is the line.
 */
export function provenanceLine(memory: MemoryView, taskTitle: string | null): string {
  const parts = [
    taskTitle === null
      ? `from ${MEMORY_SOURCE_KIND_LABEL[memory.provenance.sourceKind]}`
      : `from ${MEMORY_SOURCE_KIND_LABEL[memory.provenance.sourceKind]} of “${taskTitle}”`,
  ]
  if (memory.provenance.runId !== null) parts.push(`run ${short(memory.provenance.runId)}`)
  if (memory.provenance.goalVersion !== null) parts.push(`goal v${String(memory.provenance.goalVersion)}`)
  if (memory.verifiedBy !== null) parts.push(`verified by ${MEMORY_VERIFIER_LABEL[memory.verifiedBy]}`)
  return parts.join(' · ')
}
