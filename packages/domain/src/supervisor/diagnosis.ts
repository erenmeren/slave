import type { PermissionKind } from '../permission/kinds.js'

/**
 * What a failure WAS, as far as rows can say (spec §3).
 *
 * The whole point of this module is the sentence in §3: "a remedy is chosen from facts the world
 * now carries, not from the model's guess". Before it, one action -- `unblock_task` -- was offered
 * for every stuck task whatever had happened to it, which made the remedy a coin toss: the audit
 * task that started this milestone was retried three times against a permission wall nobody had
 * looked at.
 *
 * Five readings, and the four that are not `unknown` each name a DIFFERENT remedy:
 * - `infrastructure`: the run broke, not the work. The same run again is the whole remedy.
 * - `denied_tool`: the worker was refused something this work cannot be done without. The remedy
 *   is the grant, carried on the retry.
 * - `lost`: the worker went in circles or ran out of time with nothing refused it. The remedy is
 *   the retry plus a sentence telling it so.
 * - `rejected`: a reviewer judged the work and said no. The work is wrong; retrying it once more
 *   is reasonable, retrying it forever is not.
 * - `unknown`: nothing here reads it. The rules retry it once and then ask a person -- which is
 *   what "unknown" should cost, rather than a guess dressed as a diagnosis.
 */
export type FailureReading = 'infrastructure' | 'denied_tool' | 'lost' | 'rejected' | 'unknown'

/** The reading, plus the one kind a `denied_tool` reading is ABOUT -- null for every other
 *  reading, because no other remedy names an operation. */
export interface FailureDiagnosis {
  readonly reading: FailureReading
  readonly deniedKind: string | null
}

/** Everything {@link readFailure} reads. A flat input rather than a `SupervisorTask`, for
 *  `AnswerEligibility`'s own reason: control asks the same question of a task row, and a shape it
 *  can build from one is what keeps the two sides running one rule instead of two that drift. */
export interface FailureFacts {
  /** The newest `run.failed` reason on the task, or null for a task that has never failed. */
  readonly reason: string | null
  /** The distinct kinds `run.tool_denied` recorded across the task's runs. */
  readonly deniedKinds: readonly string[]
  /** What the PLAN said this task needs (R5, `Task.requiredPermissions`). Empty until Task 5
   *  puts the column on the world -- and empty is a real state besides: most tasks need neither. */
  readonly requiredPermissions: readonly string[]
  /** `Task.requiredRole`, free text an operator or a planner typed. */
  readonly requiredRole: string
}

/**
 * The reasons that mean the SYSTEM failed rather than the worker.
 *
 * Each marker is a failure this repository has actually recorded: `maxBuffer` is the child process
 * writing more than the buffer holds, `could not be read` is a transcript the run wrote and the
 * reader could not open, `spawn`/`ENOENT`/`EACCES` are the vendor CLI not being there or not being
 * runnable, `adapter`/`provider` are a refusal from the other side of the network, and `no valid
 * verdict` is a review run that produced output a verdict could not be parsed out of.
 *
 * None of them says anything about the work, which is exactly why the remedy is the same run
 * again: nothing was decided, so nothing has to be changed.
 */
const INFRASTRUCTURE = /maxBuffer|could not be read|spawn|ENOENT|EACCES|adapter|provider|no valid verdict/iu

/** The reasons that mean the worker is LOST: the two guardrails that stop a run going nowhere, the
 *  words the breaker uses for it, and the stream ending with nothing concluded. */
const LOST = /behavioural_loop|run_timeout|going in circles|output stream ended/iu

/** A reviewer's no. The first alternative is spec §3's own wording ("review verdict rejected") and
 *  the second is what a bare rejection reason looks like on the row; keeping both is keeping the
 *  table's words beside the row's. */
const REJECTED = /review.*rejected|rejected/iu

/** The one operation a role can imply on its own. */
const NETWORK_FETCH: PermissionKind = 'network_fetch'

/**
 * The roles whose work IS the web (spec R3): research, the three that sell, support, and academic
 * work. A task for one of these that was refused {@link NETWORK_FETCH} was refused the thing it
 * exists to do, whatever its plan remembered to ask for -- which is the case the audit task hit,
 * where the planner named no needs at all.
 *
 * Exported because it is a RULE a person may need to read, not a detail: adding a role here widens
 * what the Supervisor will ask a permission for by itself.
 */
export const NETWORK_ROLES: readonly string[] = ['research', 'marketing', 'sales', 'paid-media', 'support', 'academic']

/** The kind a `denied_tool` reading is about, or null when no refusal explains this failure. */
function deniedKindFor(input: FailureFacts): string | null {
  // What the PLAN asked for wins: a task that says it needs an operation and was refused it needs
  // no further argument. The task's own order, so two passes over one world name the same kind.
  const asked = input.deniedKinds.find((kind) => input.requiredPermissions.includes(kind))
  if (asked !== undefined) return asked
  // Lowercased on both sides: `requiredRole` is free text, and `Research` compared against an
  // already-lowercase list matched nothing (`staffingCandidates`' own bug, final review Minor 7).
  if (!NETWORK_ROLES.includes(input.requiredRole.toLowerCase())) return null
  return input.deniedKinds.includes(NETWORK_FETCH) ? NETWORK_FETCH : null
}

/**
 * Read one failure (spec §3's table, top row first).
 *
 * Pure and total: same facts in, same reading out, and a failure it cannot read is `unknown`
 * rather than a best guess. The ORDER is the table's order, and the one place it decides anything
 * is a failure carrying both an infrastructure marker and a refusal: infrastructure wins, because
 * a run that died on a missing binary or a full buffer never reached the tool it would have been
 * refused, and granting a permission for a wall the run never hit is a remedy for something that
 * did not happen. The retry the infrastructure reading offers costs one attempt, and the refusal
 * is still on the task's facts for the pass after it.
 */
export function readFailure(input: FailureFacts): FailureDiagnosis {
  const reason = input.reason ?? ''
  if (INFRASTRUCTURE.test(reason)) return { reading: 'infrastructure', deniedKind: null }
  const deniedKind = deniedKindFor(input)
  if (deniedKind !== null) return { reading: 'denied_tool', deniedKind }
  // "With no denied kind" is the table's own clause, and it is deliberately ANY refusal rather
  // than only the ones above: a worker that kept meeting a wall nothing here can grant may well be
  // going in circles AROUND that wall, and a steer telling it to change approach would be advice
  // about the wrong thing.
  if (input.deniedKinds.length === 0 && LOST.test(reason)) return { reading: 'lost', deniedKind: null }
  if (REJECTED.test(reason)) return { reading: 'rejected', deniedKind: null }
  return { reading: 'unknown', deniedKind: null }
}
