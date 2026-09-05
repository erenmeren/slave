import type { RunState } from '../run/state.js'

export type SlaveStatus = 'idle' | 'starting' | 'working' | 'pausing' | 'paused' | 'resuming' | 'stopping'

/**
 * Slave status is always computed from the slave's active run. It is never stored,
 * so slave state and run state cannot drift apart.
 */
export function deriveSlaveStatus(activeRun: RunState | null): SlaveStatus {
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
