import type { MemoryView } from './provenance.js'
import type { MemoryType } from './types.js'

/**
 * How many memories one prompt may carry (M49 R3). Twelve blocks of at most a title and a
 * paragraph sit under a task and a contract without becoming the biggest thing in the prompt --
 * and a run that needs more than twelve pieces of knowledge to start needs a smaller task.
 */
export const MEMORIES_IN_PROMPT = 12

/**
 * The RANKING order of the six types (R3) -- deliberately not `MEMORY_TYPES`' declaration order.
 *
 * What was DECIDED outranks what is known, which outranks how things are done, which outranks what
 * went wrong, which outranks what somebody reported, which outranks a guess. A run that can read
 * only one of these should read the decision.
 */
export const MEMORY_TYPE_ORDER: readonly MemoryType[] = [
  'decision',
  'fact',
  'procedure',
  'lesson',
  'observation',
  'hypothesis',
]

export interface RetrieveInput {
  readonly memories: readonly MemoryView[]
  readonly scopes: {
    readonly companyId: string | null
    readonly workspaceId: string
    /** The worker this run is FOR. Null for a preview that has picked no persona (plan erratum
     *  E14) -- and then no worker-scoped memory and no lesson qualifies at all. */
    readonly slaveId: string | null
  }
  readonly refs: {
    readonly taskId: string | null
    readonly requiredCapabilities: readonly string[]
    readonly goalVersion: number | null
  }
  readonly kind: 'implementation' | 'planning'
  readonly limit?: number
}

/** 0 = the worker's own, 1 = this project's, 2 = the company's. Lower wins: the more specific the
 *  scope, the more likely the knowledge is about the thing in front of this run. */
function specificity(memory: MemoryView): number {
  if (memory.scope === 'worker') return 0
  if (memory.scope === 'workspace') return 1
  return 2
}

/**
 * The verified knowledge this run should be given, best first (M49 R3).
 *
 * PURE and total: the caller loads a bounded set of rows and this decides which of them reach a
 * prompt, so "what did this run know" is answerable from a fixture and reproducible months later.
 *
 * Eligibility is three rules and no judgement: `verified` only (a candidate is a worker's claim, a
 * superseded row is out of date and a removed one was withdrawn -- none of the three is knowledge);
 * the scope must be one of this run's three; and a LESSON is only ever shown to the worker it
 * belongs to, because a lesson is somebody's own mistake and handing it to a colleague is gossip
 * rather than knowledge.
 *
 * The sources of an INCLUDED summary are dropped (R5): a condensation is an index of them, and
 * showing both spends the prompt twice on one thing.
 *
 * Ranking is five comparators and ends on the id, so two runs over the same rows produce the same
 * prompt byte for byte.
 */
export function retrieveMemories(input: RetrieveInput): readonly MemoryView[] {
  const { companyId, workspaceId, slaveId } = input.scopes
  const wanted = new Set(input.refs.requiredCapabilities)

  const eligible = input.memories.filter((memory) => {
    if (memory.status !== 'verified') return false
    if (memory.scope === 'workspace' && memory.workspaceId !== workspaceId) return false
    if (memory.scope === 'company' && (companyId === null || memory.companyId !== companyId)) return false
    if (memory.scope === 'worker' && (slaveId === null || memory.slaveId !== slaveId)) return false
    // Belt and braces beside the scope rule above: a lesson is worker-scoped by construction
    // (`promotionFor`), and a hand-written one that is not stays out of everybody else's prompt.
    if (memory.type === 'lesson' && (slaveId === null || memory.slaveId !== slaveId)) return false
    return true
  })

  // Only the sources of a summary that is ITSELF included: a condensation the scope rules dropped
  // must not take its sources down with it.
  const covered = new Set(eligible.flatMap((memory) => memory.sourceIds))
  const shown = eligible.filter((memory) => !covered.has(memory.id))

  const overlap = (memory: MemoryView): number => memory.capabilities.filter((key) => wanted.has(key)).length

  const ranked = [...shown].sort((a, b) => {
    const scope = specificity(a) - specificity(b)
    if (scope !== 0) return scope
    const type = MEMORY_TYPE_ORDER.indexOf(a.type) - MEMORY_TYPE_ORDER.indexOf(b.type)
    if (type !== 0) return type
    const capability = overlap(b) - overlap(a)
    if (capability !== 0) return capability
    const task =
      Number(b.provenance.taskId === input.refs.taskId) - Number(a.provenance.taskId === input.refs.taskId)
    if (task !== 0) return task
    const age = Date.parse(b.createdAt) - Date.parse(a.createdAt)
    if (age !== 0) return age
    return a.id.localeCompare(b.id)
  })

  return ranked.slice(0, input.limit ?? MEMORIES_IN_PROMPT)
}
