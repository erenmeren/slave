/**
 * Shared world fixtures for the supervisor domain tests. Not a `.test.ts` file, so vitest's
 * `packages/**\/test/**\/*.test.ts` include never collects it -- it is only ever imported.
 *
 * Every builder starts from a world in which NOTHING is stuck: no goal, no tasks, no slaves, no
 * questions, no halt. Each test then adds exactly the one fact its predicate is about, so a
 * fixture can never pass by accident through a second situation it did not mean to create.
 */
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'
import type { Runbook } from '../../src/runbook/spec.js'
import type {
  SupervisorDecisionRecord,
  SupervisorQuestion,
  SupervisorRun,
  SupervisorSlave,
  SupervisorTask,
  SupervisorWorld,
  TaskFailure,
  ThreadMessage,
} from '../../src/supervisor/world.js'

export const NOW = Date.parse('2026-09-09T12:00:00.000Z')

/**
 * The two-row taxonomy the M47 capability cases are read against, shared by `observe.test.ts` and
 * `candidates.test.ts` so the two files cannot disagree about what `security.application` projects
 * to. Deliberately tiny: nothing matches on a key that is not a row (R1), so two rows are enough to
 * say "this one is staffed and that one is not".
 */
export const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: [] },
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: [] },
]

export function task(overrides: Partial<SupervisorTask> = {}): SupervisorTask {
  return {
    id: 't1',
    title: 'Add the thing',
    status: 'backlog',
    attempt: 1,
    maxAttempts: 3,
    requiredRole: 'backend',
    integratedAt: null,
    statusSince: NOW,
    dependents: 0,
    dependenciesDone: true,
    latestGuardrail: null,
    // The board's tasks come from a plan by default, stamped with the same version the default
    // world carries -- so nothing is stale until a test says the goal moved.
    goalVersion: 0,
    // M47: a task planned before capabilities existed asks for none, which is what every fixture
    // in this file means unless it says otherwise.
    requiredCapabilities: [],
    // M50 R3: nobody is assigned by default -- a fixture says who holds a task when the case is
    // about that. A real planned board carries a holder on every task since H2, so a case about
    // `engagement_over`'s open-work clause has to set this rather than assume the column is dead.
    assigneeId: null,
    // M48: a task planned before runbooks existed belongs to no stage, which is what every fixture
    // in this file means unless it says otherwise -- and a task with no stage carries no
    // escalation sentence either.
    stage: null,
    stageEscalation: null,
    // R2: a task that has never failed and never been denied anything, which is what every
    // fixture in this file means unless it says otherwise -- a test wanting `task_failed`'s
    // remedy facts hands the world a `latestFailure`/`deniedKinds`/`failureCount` of its own.
    latestFailure: null,
    deniedKinds: [],
    failureCount: 0,
    // R3: nobody has retried this task yet.
    retries: 0,
    ...overrides,
  }
}

/**
 * One `run.failed` on a task (R2). The default is the emptiest failure that is still a real one:
 * an implementation run, a reason no rule in `readFailure` matches, and NO worker -- so a test
 * that wants a grant on the retry has to say whose run was refused rather than getting one by
 * accident (fix round 1, Important 1).
 */
export function taskFailure(overrides: Partial<TaskFailure> = {}): TaskFailure {
  return {
    runKind: 'implementation',
    reason: 'the run ended without finishing the work',
    at: NOW - 1,
    slaveId: null,
    ...overrides,
  }
}

/** A runbook the workspace could adopt (M48 R5). One stage and one keyword: enough to be a real
 *  runbook, small enough that a test says which fact it is about. */
export function runbook(overrides: Partial<Runbook> & { key: string }): Runbook {
  return {
    id: `rb-${overrides.key}`,
    name: overrides.key,
    description: 'a runbook',
    keywords: ['ship'],
    requiredCapabilities: [],
    optionalCapabilities: [],
    stages: [
      { key: 'design', title: 'Design', objective: 'Decide', capabilities: [], dependsOn: [], expectedOutputs: [], gates: [], retry: null, escalation: null },
    ],
    source: 'seed',
    sourceTemplateId: null,
    ...overrides,
  }
}

export function slave(overrides: Partial<SupervisorSlave> = {}): SupervisorSlave {
  return {
    id: 's1',
    name: 'Alex',
    role: 'Backend Engineer',
    runtimeRoles: ['backend'],
    // M47: what the worker PROVIDES. Empty by default, so a capability situation only ever fires
    // in a test that says which capability it is about.
    capabilities: [],
    busy: false,
    // M50 R1/R3: an ordinary project worker, engaged for nothing in particular and never released
    // -- which is what every fixture in this file means unless it says otherwise.
    lifecycle: 'project',
    engagementTaskId: null,
    released: false,
    // M53 R10/R1/R9: nothing has been refused this worker, nobody hired them from a persona and no
    // model is pinned to them -- so the permission, preference and cost steps of `rankCandidates`
    // only ever decide in a test that says which denial, which template or which model it is about.
    deniedKinds: [],
    personId: 'p-default',
    templateId: null,
    model: null,
    ...overrides,
  }
}

/**
 * One live run (M51 R3). The default is a HEALTHY busy run: level `none`, no trip, no cap -- so a
 * world handed `runs: [supervisorRun()]` raises nothing, and a test that wants `run_looping` has to
 * say which rung and which trip it is about.
 */
export function supervisorRun(over: Partial<SupervisorRun> = {}): SupervisorRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    slaveId: 'slave-1',
    status: 'working',
    toolCalls: 12,
    toolCallCap: null,
    breakerLevel: 'none',
    breakerTrips: 0,
    breakerSteers: 0,
    trip: null,
    detail: null,
    count: null,
    ...over,
  }
}

export function threadMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return { messageId: 'm1', kind: 'question', senderSlaveId: 's1', body: 'Which port?', createdAt: NOW, ...overrides }
}

/**
 * A pending question. The M39 fields default to the emptiest thing that is still a real question:
 * no thread, no recorded run prompt and NO holders, so a test that wants a re-address candidate has
 * to say who could take it rather than getting one by accident.
 */
export function question(overrides: Partial<SupervisorQuestion> = {}): SupervisorQuestion {
  return {
    messageId: 'm1',
    askerSlaveId: 's1',
    recipientRole: 'backend',
    recipientSlaveId: null,
    createdAt: NOW,
    body: 'Which port does the database listen on?',
    taskId: 't1',
    taskTitle: 'Add the thing',
    taskDescription: 'Connect to PostgreSQL on port 5433.',
    taskHandoff: null,
    senderRunId: 'run-1',
    threadId: 'th-1',
    thread: [],
    askerRunPrompt: null,
    holders: [],
    ...overrides,
  }
}

export function decision(overrides: Partial<SupervisorDecisionRecord> = {}): SupervisorDecisionRecord {
  return {
    situationKind: 'workspace_halted',
    subjectId: 'ws-1',
    // The neutral default: a decision that did nothing. A test about the mailbox says
    // `actionKind: 'answer_question'` for itself rather than inheriting one by accident.
    actionKind: 'no_action',
    status: 'applied',
    tier: 'applied',
    createdAt: NOW,
    resolvedAt: null,
    ...overrides,
  }
}

export function world(overrides: Partial<SupervisorWorld> = {}): SupervisorWorld {
  return {
    workspaceId: 'ws-1',
    // R1: `propose` is today's behaviour and every existing fixture in this directory means
    // exactly that unless a test says otherwise -- a test about `act` hands the world its own.
    autonomy: 'propose',
    now: NOW,
    goal: null,
    // 0 is "the goal was never set" (M40 §1), which is what `goal: null` above means.
    goalVersion: 0,
    halted: null,
    // R4: no halt has ever been cleared here, so the once-an-hour rule only ever decides in a test
    // that says when the last clear was.
    haltClearedAt: null,
    budgetExhausted: false,
    tasks: [],
    slaves: [],
    questions: [],
    decisions: [],
    // M47: an EMPTY taxonomy is a real state -- a database whose taxonomy has never been synced --
    // and every capability rule is a no-op under it. That is what keeps every pre-M47 case in this
    // directory reading exactly as it always did.
    pool: [],
    catalog: [],
    taxonomy: [],
    // M48: no runbook adopted and none on offer, so `runbook_recommended` only ever fires in a
    // test that hands the world some runbooks to recommend.
    runbook: null,
    runbooks: [],
    // M49: a project whose workers have reported nothing unverified, which is what every fixture
    // in this file means unless it says otherwise.
    staleMemoryCandidates: 0,
    // M51 R3: no run in flight, so `run_looping` only ever fires in a test that hands the world a
    // run and says which rung it is on. Defaulted here for the M49/M50 fixture rule -- every
    // existing case in this directory keeps meaning exactly what it meant.
    runs: [],
    // M52 R5: nothing has been refused, so `permission_blocked` only ever fires in a test that
    // hands the world a denial and says which worker and which operation it is about.
    denials: [],
    // M53 R9/R3: nobody has expressed a staffing preference and no profile has a record, so the
    // preference and evidence steps only ever decide in a test that hands the world one.
    staffingPreferences: [],
    evidence: [],
    // H4a: the four planning facts, all saying "planning is fine here" -- a runtime IS configured,
    // nothing has failed, nobody has reset the cap and nothing is planning right now. So
    // `planning_stalled` only ever fires in a test that says which of the three reasons it is
    // about, and every case written before this hotfix keeps meaning exactly what it meant.
    runtimeConfigured: true,
    planningFailuresSinceGoal: 0,
    planningResetsThisVersion: 0,
    livePlanning: false,
    ...overrides,
  }
}

/** `[kind, subjectId]` pairs -- what almost every `observe` assertion is actually about. */
export function keys(situations: readonly { kind: string; subjectId: string }[]): [string, string][] {
  return situations.map((s) => [s.kind, s.subjectId])
}
