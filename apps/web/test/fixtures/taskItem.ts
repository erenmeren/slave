import type { TaskBoardItem } from '../../src/server/tasks'

/**
 * One board item, defaulted, so a case states only what it is about.
 *
 * A FILE rather than a local helper in one test (M48 t4): `tasks-components.test.tsx` has carried
 * its own copy of this shape since M23, and a second copy in the handoff case would be a third
 * place to add a field to. The existing one stays where it is -- moving it would rewrite a file
 * this task is not about -- but nothing new needs to repeat it.
 */
export function taskItem(over: Partial<TaskBoardItem>): TaskBoardItem {
  return {
    id: 't1',
    title: 'Add the thing',
    description: 'Add the thing to the app',
    status: 'running',
    priority: 1,
    attempt: 1,
    maxAttempts: 3,
    assigneeName: 'Alex',
    branch: 'feature/add-the-thing',
    lastRejectionReason: null,
    goalVersion: null,
    integratedAt: null,
    runs: [],
    collectable: false,
    artifacts: [],
    handoff: null,
    stage: null,
    ...over,
  }
}
