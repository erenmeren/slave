/**
 * Shared world fixtures for the supervisor domain tests. Not a `.test.ts` file, so vitest's
 * `packages/**\/test/**\/*.test.ts` include never collects it -- it is only ever imported.
 *
 * Every builder starts from a world in which NOTHING is stuck: no goal, no tasks, no slaves, no
 * questions, no halt. Each test then adds exactly the one fact its predicate is about, so a
 * fixture can never pass by accident through a second situation it did not mean to create.
 */
import type {
  SupervisorDecisionRecord,
  SupervisorQuestion,
  SupervisorSlave,
  SupervisorTask,
  SupervisorWorld,
} from '../../src/supervisor/world.js'

export const NOW = Date.parse('2026-09-09T12:00:00.000Z')

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
    ...overrides,
  }
}

export function slave(overrides: Partial<SupervisorSlave> = {}): SupervisorSlave {
  return { id: 's1', name: 'Alex', role: 'Backend Engineer', runtimeRoles: ['backend'], busy: false, ...overrides }
}

export function question(overrides: Partial<SupervisorQuestion> = {}): SupervisorQuestion {
  return { messageId: 'm1', askerSlaveId: 's1', recipientRole: 'backend', recipientSlaveId: null, createdAt: NOW, ...overrides }
}

export function decision(overrides: Partial<SupervisorDecisionRecord> = {}): SupervisorDecisionRecord {
  return {
    situationKind: 'workspace_halted',
    subjectId: 'ws-1',
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
    now: NOW,
    goal: null,
    halted: null,
    budgetExhausted: false,
    tasks: [],
    slaves: [],
    questions: [],
    decisions: [],
    ...overrides,
  }
}

/** `[kind, subjectId]` pairs -- what almost every `observe` assertion is actually about. */
export function keys(situations: readonly { kind: string; subjectId: string }[]): [string, string][] {
  return situations.map((s) => [s.kind, s.subjectId])
}
