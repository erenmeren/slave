import type { AgentCardData } from '../server/overview'

const DOT: Record<AgentCardData['status'], string> = {
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
}: {
  readonly agent: AgentCardData
  readonly liveActionLine: string | null
}): React.JSX.Element {
  const line = liveActionLine ?? agent.actionLine
  return (
    <article className="flex flex-col gap-2 rounded border border-line bg-bg-1 p-4">
      <header className="flex items-center gap-2">
        <span
          data-testid="status-dot"
          className={`inline-block h-2 w-2 rounded-full ${DOT[agent.status]} ${agent.status === 'working' ? 'animate-pulse' : ''}`}
        />
        <span className="text-sm font-medium">{agent.name}</span>
        <span className="text-xs text-text-3">{agent.role}</span>
        <span data-testid="status-label" className="ml-auto text-xs text-text-2">
          {agent.status}
        </span>
      </header>
      <div className="text-sm text-text-1">{agent.taskTitle ?? <span className="text-text-3">idle</span>}</div>
      <div data-testid="action-line" className="h-5 truncate font-mono text-xs text-text-2">
        {line}
      </div>
      <footer className="flex items-center gap-2">
        <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-text-3">
          {agent.provider}
        </span>
        <span className="ml-auto flex gap-1">
          <button disabled title="arrives in M5" className="rounded border border-line px-2 py-0.5 text-xs text-text-3">
            pause
          </button>
          <button disabled title="stop arrives in M5" className="rounded border border-line px-2 py-0.5 text-xs text-text-3">
            stop
          </button>
        </span>
      </footer>
    </article>
  )
}
