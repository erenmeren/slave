import type { RunState } from '../run/state.js'

export type AgentStatus = 'idle' | 'starting' | 'working' | 'pausing' | 'paused' | 'resuming' | 'stopping'

/**
 * Agent status is always computed from the agent's active run. It is never stored,
 * so agent state and run state cannot drift apart.
 */
export function deriveAgentStatus(activeRun: RunState | null): AgentStatus {
  if (activeRun === null) return 'idle'

  switch (activeRun.status) {
    case 'starting':
      return 'starting'
    case 'working':
      return 'working'
    case 'pause_requested':
      return 'pausing'
    case 'paused':
      return 'paused'
    case 'resuming':
      return 'resuming'
    case 'stopping':
      return 'stopping'
    case 'succeeded':
    case 'failed':
    case 'stopped':
      return 'idle'
  }
}
