declare const brand: unique symbol

type Brand<T, B extends string> = T & { readonly [brand]: B }

export type AgentId = Brand<string, 'AgentId'>
export type TaskId = Brand<string, 'TaskId'>
export type RunId = Brand<string, 'RunId'>
export type WorkspaceId = Brand<string, 'WorkspaceId'>

export const agentId = (value: string): AgentId => value as AgentId
export const taskId = (value: string): TaskId => value as TaskId
export const runId = (value: string): RunId => value as RunId
export const workspaceId = (value: string): WorkspaceId => value as WorkspaceId
