import type { ReactElement, ReactNode } from 'react'
import type { DomainEventType } from '@ai-team-os/db'
import { ActivityCard, type ActivityCardProps } from './ActivityCard'

// Every payload field name below is copied verbatim from `packages/domain/src/events/schema.ts`
// (`executionEventSchema`'s per-type `payload` object) — never guessed. `ActivityEventRow.payload`
// is a bare `Record<string, unknown>` (Task 2), so each card casts to the shape its own event type
// carries; the registry's `satisfies Record<DomainEventType, …>` below is what actually proves
// every type got a card, not these casts.

const TRANSITION_COLOR = {
  idle: 'text-status-idle',
  starting: 'text-status-starting',
  paused: 'text-status-paused',
  stopping: 'text-status-stopping',
  working: 'text-status-working',
  danger: 'text-status-danger',
  warn: 'text-status-warn',
} as const

/** A status-coloured transition label — the recurring "<coloured word> — <detail>" shape shared
 *  by the run-lifecycle and task-lifecycle card bodies. */
function Transition({
  tone,
  label,
  children,
}: {
  readonly tone: keyof typeof TRANSITION_COLOR
  readonly label: string
  readonly children?: ReactNode
}): ReactElement {
  return (
    <span>
      <span data-testid="transition-label" className={`font-medium ${TRANSITION_COLOR[tone]}`}>
        {label}
      </span>
      {children !== undefined && <span className="text-text-2"> — {children}</span>}
    </span>
  )
}

// ---- task.* (schema.ts:16-23, 45-52) --------------------------------------------------------
// The task's title is already carried by the shared shell's task link (`taskTitle` prop) — these
// bodies add only what the shell doesn't: the transition itself, plus rework/verify_failed's
// failure detail (spec §4.5).

function TaskCreatedCard(props: ActivityCardProps): ReactElement {
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="task created" />
    </ActivityCard>
  )
}

function TaskStartedCard(props: ActivityCardProps): ReactElement {
  return (
    <ActivityCard {...props}>
      <Transition tone="starting" label="task started" />
    </ActivityCard>
  )
}

function TaskDoneCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { branch: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="working" label="task done">
        <span data-testid="task-branch" className="font-mono">
          {payload.branch}
        </span>
      </Transition>
    </ActivityCard>
  )
}

function TaskReworkCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { reason: string; attempt: number }
  return (
    <ActivityCard {...props}>
      <Transition tone="warn" label="sent back for rework">
        <span data-testid="rework-reason">{payload.reason}</span>{' '}
        <span className="text-text-3">(attempt {payload.attempt})</span>
      </Transition>
    </ActivityCard>
  )
}

function TaskVerifyingCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { commandCount: number }
  return (
    <ActivityCard {...props}>
      <Transition tone="starting" label="verifying">
        <span data-testid="verify-command-count">{payload.commandCount} commands</span>
      </Transition>
    </ActivityCard>
  )
}

function TaskVerifyPassedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { branch: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="working" label="verify passed">
        <span data-testid="task-branch" className="font-mono">
          {payload.branch}
        </span>
      </Transition>
    </ActivityCard>
  )
}

function TaskVerifyFailedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { command: string; exitCode: number }
  return (
    <ActivityCard {...props}>
      <Transition tone="danger" label="verify failed">
        <span data-testid="verify-failed-reason" className="font-mono">
          {payload.command}
        </span>{' '}
        <span className="text-text-3">(exit {payload.exitCode})</span>
      </Transition>
    </ActivityCard>
  )
}

function TaskFailedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { reason: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="danger" label="task failed">
        <span data-testid="task-failed-reason">{payload.reason}</span>
      </Transition>
    </ActivityCard>
  )
}

// ---- run.* lifecycle (schema.ts:24, 30-31, 60-66) --------------------------------------------

function RunStartedCard(props: ActivityCardProps): ReactElement {
  return (
    <ActivityCard {...props}>
      <Transition tone="starting" label="run started" />
    </ActivityCard>
  )
}

function RunPausedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { atStep: number }
  return (
    <ActivityCard {...props}>
      <Transition tone="paused" label="run paused">
        <span data-testid="paused-step">at step {payload.atStep}</span>
      </Transition>
    </ActivityCard>
  )
}

function RunResumedCard(props: ActivityCardProps): ReactElement {
  return (
    <ActivityCard {...props}>
      <Transition tone="starting" label="run resumed" />
    </ActivityCard>
  )
}

function RunSucceededCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { numTurns: number; costUsd: number }
  return (
    <ActivityCard {...props}>
      <Transition tone="working" label="run succeeded">
        <span data-testid="run-succeeded-stats">
          {payload.numTurns} turns · ${payload.costUsd.toFixed(2)}
        </span>
      </Transition>
    </ActivityCard>
  )
}

function RunFailedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { reason: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="danger" label="run failed">
        <span data-testid="run-failed-reason">{payload.reason}</span>
      </Transition>
    </ActivityCard>
  )
}

// ---- run.tool_call / run.output (schema.ts:25-29, 53) ------------------------------------------
// The compact body shows a truncated preview; the shared payload `<details>` (every card has one)
// already carries the un-truncated field, so "un-truncated on expand" (spec §4.5) needs no
// separate mechanism here.

const PREVIEW_LENGTH = 120

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

function RunToolCallCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { name: string; summary: string }
  return (
    <ActivityCard {...props}>
      <span data-testid="tool-name" className="font-mono font-medium text-text-1">
        {payload.name}
      </span>
      <span className="text-text-2"> — {truncate(payload.summary, PREVIEW_LENGTH)}</span>
    </ActivityCard>
  )
}

function RunOutputCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { text: string }
  return (
    <ActivityCard {...props}>
      <pre data-testid="run-output-text" className="whitespace-pre-wrap font-mono text-xs text-text-1">
        {truncate(payload.text, PREVIEW_LENGTH)}
      </pre>
    </ActivityCard>
  )
}

// ---- guardrail.tripped (schema.ts:40-44) -------------------------------------------------------
// The real payload carries exactly two fields — `guardrail` (the limit's name, e.g.
// `budget_exhausted`, `concurrency`) and `detail` (the bound and the observed value folded into
// one free-text sentence, e.g. "Spent $20 of $20." — see `guardrails/evaluate.ts`'s breach
// builders). There is no separate `bound`/`value` pair on the wire to split apart.

function GuardrailTrippedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { guardrail: string; detail: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="warn" label={payload.guardrail}>
        <span data-testid="guardrail-detail">{payload.detail}</span>
      </Transition>
    </ActivityCard>
  )
}

// ---- interventions (schema.ts:32-39, 54-59) ----------------------------------------------------
// `event.actor` (human/agent/system) is already on the shared shell's actor badge; these bodies
// add the payload's own record of *who* intervened (`requestedBy`) and *what* they said
// (`message`/`body`) — the two things the envelope's actor alone doesn't carry.

function RunPauseRequestedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { requestedBy: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="paused" label="pause requested">
        <span data-testid="requested-by">{payload.requestedBy}</span>
      </Transition>
    </ActivityCard>
  )
}

function RunResumeRequestedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { requestedBy: string; message: string | null }
  return (
    <ActivityCard {...props}>
      <Transition tone="starting" label="resume requested">
        <span data-testid="requested-by">{payload.requestedBy}</span>
      </Transition>
      {payload.message !== null && (
        <p data-testid="resume-message" className="mt-1 text-text-2">
          {payload.message}
        </p>
      )}
    </ActivityCard>
  )
}

function RunStoppedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { reason: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="stopping" label="run stopped">
        <span data-testid="stop-reason">{payload.reason}</span>
      </Transition>
    </ActivityCard>
  )
}

function AgentMessageSentCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    category: 'instruction' | 'feedback' | 'context' | 'priority_change' | 'question_response'
    body: string
  }
  return (
    <ActivityCard {...props}>
      <span
        data-testid="message-category"
        className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-text-3"
      >
        {payload.category}
      </span>
      <p data-testid="message-body" className="mt-1 text-text-1">
        {payload.body}
      </p>
    </ActivityCard>
  )
}

/**
 * One card component per `DomainEventType`. `satisfies` (not a type annotation) is load-bearing:
 * it keeps each entry's own component type while still failing the build the moment a type is
 * missing, doubled, or misspelled — the same exhaustiveness idiom `EVENT_TYPE_BY_DOMAIN_TYPE`
 * (`packages/db/src/enums.ts`) uses for the type-to-db-value map.
 */
export const ACTIVITY_CARDS = {
  'task.created': TaskCreatedCard,
  'task.started': TaskStartedCard,
  'task.done': TaskDoneCard,
  'task.rework': TaskReworkCard,
  'run.started': RunStartedCard,
  'run.tool_call': RunToolCallCard,
  'run.paused': RunPausedCard,
  'run.resumed': RunResumedCard,
  'agent.message_sent': AgentMessageSentCard,
  'guardrail.tripped': GuardrailTrippedCard,
  'task.verifying': TaskVerifyingCard,
  'task.verify_passed': TaskVerifyPassedCard,
  'task.verify_failed': TaskVerifyFailedCard,
  'task.failed': TaskFailedCard,
  'run.output': RunOutputCard,
  'run.pause_requested': RunPauseRequestedCard,
  'run.resume_requested': RunResumeRequestedCard,
  'run.stopped': RunStoppedCard,
  'run.succeeded': RunSucceededCard,
  'run.failed': RunFailedCard,
} satisfies Record<DomainEventType, (props: ActivityCardProps) => ReactElement>
