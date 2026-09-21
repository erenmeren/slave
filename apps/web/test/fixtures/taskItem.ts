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
    // H2 fix round 1: required on the DTO. A planned task always names the role it needs, which is
    // what the card's "nobody holds this role yet" sentence is about.
    requiredRole: 'backend',
    branch: 'feature/add-the-thing',
    lastRejectionReason: null,
    goalVersion: null,
    // M54 R9: `TaskBoardItem.origin` is REQUIRED, and null MEANS "a person set the version this
    // task came from" -- which is every task before this milestone. A case about an
    // externally-originated one passes an `ExternalOrigin` through `over`.
    origin: null,
    integratedAt: null,
    runs: [],
    collectable: false,
    artifacts: [],
    handoff: null,
    stage: null,
    stageTitle: null,
    ...over,
  }
}
