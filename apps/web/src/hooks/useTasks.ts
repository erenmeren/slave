'use client'

import type { TasksSnapshot } from '../server/tasks.js'
import { useWorkspaceStream, type WorkspaceStreamState } from './useWorkspaceStream.js'

export function useTasks(workspaceId: string, initial: TasksSnapshot): WorkspaceStreamState<TasksSnapshot> {
  return useWorkspaceStream<TasksSnapshot>({
    workspaceId,
    endpoint: `/api/w/${workspaceId}/tasks`,
    initial,
  })
}
