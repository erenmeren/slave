import type { AgentCardData } from '../server/overview'

export const DOT: Record<AgentCardData['status'], string> = {
  working: 'bg-status-working',
  starting: 'bg-status-starting',
  resuming: 'bg-status-starting',
  pausing: 'bg-status-paused',
  paused: 'bg-status-paused',
  stopping: 'bg-status-stopping',
  idle: 'bg-status-idle',
}

export function AgentCard({
  agent,
  liveActionLine,
  onOpen,
}: {
  readonly agent: AgentCardData
  readonly liveActionLine: string | null
  /** Opens the detail panel (spec §6) — the M4 card's disabled pause/stop buttons moved there. */
  readonly onOpen: (id: string) => void
}): React.JSX.Element {
  const line = liveActionLine ?? agent.actionLine
  return (
    <article className="flex flex-col gap-2 rounded border border-line bg-bg-1 p-4">
      <button
        type="button"
        onClick={() => onOpen(agent.id)}
        aria-label={`Open ${agent.name}'s detail panel`}
        className="flex items-center gap-2 text-left"
      >
        <span
          data-testid="status-dot"
          className={`inline-block h-2 w-2 rounded-full ${DOT[agent.status]} ${agent.status === 'working' ? 'animate-pulse' : ''}`}
        />
        <span className="text-sm font-medium">{agent.name}</span>
        <span className="text-xs text-text-3">{agent.role}</span>
        <span data-testid="status-label" className="ml-auto text-xs text-text-2">
          {agent.status}
        </span>
      </button>
      <div className="text-sm text-text-1">{agent.taskTitle ?? <span className="text-text-3">idle</span>}</div>
      <div data-testid="action-line" className="h-5 truncate font-mono text-xs text-text-2">
        {line}
      </div>
      <footer className="flex items-center gap-2">
        <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-text-3">
          {agent.provider}
        </span>
      </footer>
    </article>
  )
}
