import {
  MEMORY_BODY_MAX,
  MEMORY_CAPABILITIES_MAX,
  MEMORY_TITLE_MAX,
  MEMORY_TYPE_LABEL,
  capCodePoints,
  type MemoryScope,
  type MemoryType,
} from './types.js'
import type { MemoryDraft, MemoryView } from './provenance.js'

/**
 * How many verified memories of one type in one scope make a summary worth writing (M49 R5).
 *
 * Twenty: below it a person can read the list, and `MEMORIES_IN_PROMPT` is twelve, so a scope with
 * nineteen facts still fits the prompt's own selection rules. Past it the prompt is choosing twelve
 * of twenty-odd things nobody has ever read together, which is exactly the state a summary fixes.
 */
export const CONDENSE_THRESHOLD = 20

export interface CondenseInput {
  readonly memories: readonly MemoryView[]
  readonly scope: MemoryScope
  /** The company, workspace or worker id this condensation belongs to. */
  readonly targetId: string
  readonly type: MemoryType
  readonly threshold?: number
}

export interface Condensation {
  readonly draft: MemoryDraft
  /** Every source, in `createdAt asc, id asc` order -- the `MemorySource` rows to write. */
  readonly sourceIds: readonly string[]
}

/** The longest tail this file can append (`\n… and 999999 more` is 18 code points), rounded up and
 *  reserved BEFORE the first bullet is measured: a summary that was capped after the fact would
 *  print a count of what it dropped that its own text contradicts. */
const TAIL_RESERVE = 24

/** `2026-09-12`, out of an ISO stamp. Day resolution: a summary's title says which fortnight it
 *  covers, not which second. */
const day = (iso: string): string => iso.slice(0, 10)

/** R5's one automatic PROCEDURE: a worker's own lessons, read together, are how that worker now
 *  works. Every other type summarises as itself. */
const typeOf = (type: MemoryType, scope: MemoryScope): MemoryType =>
  type === 'lesson' && scope === 'worker' ? 'procedure' : type

/** Which id a memory of this scope is filed under. The three target columns are exclusive by
 *  construction (`targetRule`), so this is a read and never a guess. */
const targetOf = (memory: MemoryView): string | null =>
  memory.scope === 'company' ? memory.companyId : memory.scope === 'workspace' ? memory.workspaceId : memory.slaveId

/**
 * One summary of many memories, or `null` when there is nothing to summarise (M49 R5).
 *
 * PURE and deterministic: the sources are sorted `createdAt asc, id asc` before anything is
 * written, the bullet list is their titles in that order, the capability list is their union
 * sorted, and the title states the count and the range. The same rows produce the same row, byte
 * for byte, on any machine -- which is what lets a gate assert the text rather than its shape, and
 * what makes "no model call" (R5) a property of the design rather than a promise.
 *
 * A summary REPLACES nothing: the sources stay `verified`, and it is retrieval that prefers the
 * summary and drops its sources (R3). An index is not a deletion.
 */
export function condenseMemories(input: CondenseInput): Condensation | null {
  const threshold = input.threshold ?? CONDENSE_THRESHOLD

  const inScope = input.memories.filter(
    (memory) =>
      memory.status === 'verified' &&
      memory.type === input.type &&
      memory.scope === input.scope &&
      targetOf(memory) === input.targetId,
  )
  // Already indexed by a live summary, and therefore not loose knowledge any more. Read off every
  // memory in the input, not only the in-scope ones: a company summary of a project's facts would
  // still have covered them.
  const covered = new Set(input.memories.flatMap((memory) => memory.sourceIds))
  const sources = inScope
    .filter((memory) => !covered.has(memory.id) && memory.sourceIds.length === 0)
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))

  if (sources.length < threshold) return null

  const first = sources[0]!
  const last = sources[sources.length - 1]!
  const label =
    input.type === 'lesson' && input.scope === 'worker'
      ? 'What this worker has learned to do'
      : `${MEMORY_TYPE_LABEL[input.type]} summary`
  const title = capCodePoints(
    `${label} (${String(sources.length)} sources, ${day(first.createdAt)} to ${day(last.createdAt)})`,
    MEMORY_TITLE_MAX,
  )

  // The bullets, then the tail that says what did not fit. Built by measuring rather than by
  // slicing at the end, so the "and N more" is always true.
  const bullets: string[] = []
  let used = 0
  let dropped = 0
  for (const source of sources) {
    const line = `- ${source.title}`
    if (used + line.length + 1 > MEMORY_BODY_MAX - TAIL_RESERVE) {
      dropped += 1
      continue
    }
    bullets.push(line)
    used += line.length + 1
  }
  const body = dropped === 0 ? bullets.join('\n') : `${bullets.join('\n')}\n… and ${String(dropped)} more`

  return {
    sourceIds: sources.map((one) => one.id),
    draft: {
      type: typeOf(input.type, input.scope),
      scope: input.scope,
      companyId: input.scope === 'company' ? input.targetId : null,
      workspaceId: input.scope === 'workspace' ? input.targetId : null,
      slaveId: input.scope === 'worker' ? input.targetId : null,
      title,
      body: capCodePoints(body, MEMORY_BODY_MAX),
      status: 'verified',
      // Every source was verified, and nothing here was interpreted: the text is their titles.
      confidence: 'sourced',
      // Sorted, then cut to the cap a draft is allowed to carry: twenty sources can easily name
      // more than `MEMORY_CAPABILITIES_MAX` distinct keys between them, and a draft over the cap
      // is one `memoryDraftSchema` refuses -- a summary that silently never lands. Cutting the
      // SORTED union keeps the choice deterministic rather than dependent on row order.
      capabilities: [...new Set(sources.flatMap((one) => one.capabilities))]
        .toSorted((a, b) => a.localeCompare(b))
        .slice(0, MEMORY_CAPABILITIES_MAX),
      // A summary of verified knowledge is as verified as the knowledge -- and `human` because
      // every source was verified by somebody, not because a person read this one.
      verifiedBy: 'human',
      supersedesTaskCandidates: false,
      provenance: {
        sourceKind: 'condensation',
        sourceRef: null,
        createdBy: 'system',
        createdByUserId: null,
        taskId: null,
        runId: null,
        goalVersion: null,
      },
    },
  }
}
