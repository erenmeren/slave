import type { ReactElement, ReactNode } from 'react'
import type { DomainEventType } from '@slave-of-ai/db'
import {
  MEMORY_SOURCE_KIND_LABEL,
  MEMORY_STATUS_LABEL,
  MEMORY_TYPE_LABEL,
  type MemoryScope,
  type MemorySourceKind,
  type MemoryStatus,
  type MemoryType,
} from '@slave-of-ai/domain'
import { plural } from '../../lib/plural'
import { ActivityCard, type ActivityCardProps } from './ActivityCard'

// Every payload field name below is copied verbatim from `packages/domain/src/events/schema.ts`
// (`executionEventSchema`'s per-type `payload` object) — never guessed. `ActivityEventRow.payload`
// is a bare `Record<string, unknown>` (Task 2), so each card casts to the shape its own event type
// carries; the registry's `satisfies Record<DomainEventType, …>` below is what actually proves
// every type got a card, not these casts.

const TRANSITION_COLOR = {
  idle: 'text-tone-idle',
  starting: 'text-tone-planning',
  paused: 'text-tone-paused',
  stopping: 'text-tone-waiting',
  working: 'text-tone-working',
  danger: 'text-tone-blocked',
  warn: 'text-tone-waiting',
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

// M23 B2: `collectTaskWorktree` removed a terminal task's worktree -- aged out or by an
// operator's button. `idle` tone: this is bookkeeping after the task already concluded, not a
// new outcome of its own.
function TaskWorktreeCollectedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { path: string; reason: 'aged' | 'operator' | 'released'; branch: string | null }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="worktree collected">
        <span data-testid="worktree-collected-path" className="font-mono">
          {payload.path}
        </span>{' '}
        · {payload.reason}
      </Transition>
    </ActivityCard>
  )
}

function TaskDependencyAddedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { dependsOnTaskId: string; dependsOnTitle: string; requestedBy: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="dependency added">
        depends on <span data-testid="depends-on-title">{payload.dependsOnTitle}</span>
      </Transition>
      <p className="mt-1 text-text-3">
        requested by <span data-testid="requested-by">{payload.requestedBy}</span>
      </p>
    </ActivityCard>
  )
}

function TaskDependencyRemovedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { dependsOnTaskId: string; dependsOnTitle: string; requestedBy: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="dependency removed">
        no longer depends on <span data-testid="depends-on-title">{payload.dependsOnTitle}</span>
      </Transition>
      <p className="mt-1 text-text-3">
        requested by <span data-testid="requested-by">{payload.requestedBy}</span>
      </p>
    </ActivityCard>
  )
}

// ---- task.review_* / task.merge_failed (schema.ts:78-96) ---------------------------------------
// The QA review stage and merge queue (M8a): a task's diff is reviewed, then either merges or
// gets sent back — parallel to task.rework/verify_failed above but for the review/merge step.

function TaskReviewStartedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { title: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="paused" label="QA review started">
        <span data-testid="review-title">{payload.title}</span>
      </Transition>
    </ActivityCard>
  )
}

function TaskReviewApprovedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { reason: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="working" label="review approved">
        <span data-testid="review-approved-reason">{payload.reason}</span>
      </Transition>
    </ActivityCard>
  )
}

function TaskReviewRejectedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { reason: string; attempt: number }
  return (
    <ActivityCard {...props}>
      <Transition tone="warn" label="review rejected">
        <span data-testid="review-rejected-reason">{payload.reason}</span>{' '}
        <span className="text-text-3">(attempt {payload.attempt})</span>
      </Transition>
    </ActivityCard>
  )
}

function TaskMergeFailedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { reason: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="danger" label="merge failed">
        <span data-testid="merge-failed-reason">{payload.reason}</span>
      </Transition>
    </ActivityCard>
  )
}

// M35 t2: `confirmIntegration` stamped a done, hand-merged task's `integratedAt` -- empty payload
// (schema.ts), so this card carries no extra field, just the transition itself.
function TaskIntegratedCard(props: ActivityCardProps): ReactElement {
  return (
    <ActivityCard {...props}>
      <Transition tone="working" label="integrated" />
    </ActivityCard>
  )
}

// M35 t5: `unblockTask` moved a `blocked` task back to `rework` -- an operator's exit from one of
// the four parks. `attempt`/`maxAttempts` are the values AFTER the write (schema.ts); shown only
// when the ceiling was actually raised (`maxAttempts` is otherwise unremarkable, the same number
// the task always carried).
function TaskUnblockedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { attempt: number; maxAttempts: number }
  return (
    <ActivityCard {...props}>
      <Transition tone="warn" label="unblocked">
        <span className="text-text-3">
          (attempt {payload.attempt} of {payload.maxAttempts})
        </span>
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
  // costUsd is nullable (M12 Task 6): a runtime that does not report cost emits null here, not a
  // false zero -- and as of M12 Task 9 (ruling R3) it is DISPLAYED as unknown rather than folded
  // into `$0.00`. A timeline is a record of what happened; a zero nobody measured belongs on it
  // even less than it belongs in a total.
  const payload = props.event.payload as { numTurns: number; costUsd: number | null }
  return (
    <ActivityCard {...props}>
      <Transition tone="working" label="run succeeded">
        <span data-testid="run-succeeded-stats">
          {payload.numTurns} turns · {payload.costUsd === null ? '—' : `$${payload.costUsd.toFixed(2)}`}
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

// ---- run.tool_denied (schema.ts, M18 §2) --------------------------------------------------------
// A per-call refusal the slave is expected to route around -- the run continues -- so this reads
// as a warning, not a failure: `warn` is the tone the guardrail/rework/review-rejected cards
// already use for "something was refused but nothing stopped".

function RunToolDeniedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { tool: string; capability: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="warn" label="tool denied">
        <span data-testid="tool-denied-text">{`${payload.tool} denied — ${payload.capability}`}</span>
      </Transition>
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

// ---- workspace.* (schema.ts:97-119) ----------------------------------------------------------
// Workspace-scoped, task-less events: the planning run sets the workspace's goal (M8b), produces
// the task plan for it (M8b), and the org model (M10) later assigns a company to run it. These
// three share their own `workspace` kind in `TYPES_BY_KIND` (activityFilters.ts) — none of them
// carry a `taskId`.

function WorkspaceGoalSetCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { goal: string; request?: unknown }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="goal set">
        {/* M45 R3 / erratum E24: a goal version written by "tell the Supervisor what changed"
          * carries the WORDS a person asked for, and they are the whole reason this version
          * exists -- the goal document below is the standing goal plus a dated line composed from
          * them. Optional: a whole-goal set through the Settings tab has no request, and this card
          * must not invent one. Another party's text, as JSX children (spec §1). */}
        {typeof payload.request === 'string' && payload.request !== '' && (
          <span data-testid="goal-set-request" className="text-[11px] text-text-2">
            requested: {payload.request}
          </span>
        )}
        <span data-testid="goal-text">{payload.goal}</span>
      </Transition>
    </ActivityCard>
  )
}

function WorkspacePlanCreatedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    goal: string
    tasks: ReadonlyArray<{ id: string; title: string; role: string }>
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label={`planned ${payload.tasks.length} tasks`}>
        <span data-testid="plan-goal">{payload.goal}</span>
      </Transition>
      <ul className="mt-1 space-y-0.5 text-text-3">
        {payload.tasks.map((task) => (
          <li key={task.id} data-testid="plan-task-item">
            {task.title} <span className="text-text-3">({task.role})</span>
          </li>
        ))}
      </ul>
    </ActivityCard>
  )
}

// `workers` deliberately has NO `.min(1)` on the wire (schema.ts) — a pure re-sync that added
// nobody still emits with an empty array (M10 spec §5 step 4), hence the "no new workers" line.
// ---- M40 §6: the three requirement-versioning events -----------------------------------------
// A goal that moved past the board it produced starts a delta re-plan; the delta's additions LAND
// and its cancellations are only PROPOSED (ruling R1); a task that is actually taken off the board
// says why, and which requirement it was doing the work of.

/** `dispatchPlanning` started a re-plan run for a goal version (M40 §5). `starting`, the tone every
 *  other "a run is beginning" card carries -- nothing has been decided yet. */
function WorkspaceReplanStartedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { version: number }
  return (
    <ActivityCard {...props}>
      <Transition tone="starting" label={`re-planning for goal v${String(payload.version)}`} />
    </ActivityCard>
  )
}

/** M48 R5: a runbook adopted, or cleared. `idle` rather than `starting`: nothing is running --
 *  a decision about how the work will be done has been recorded. */
function WorkspaceRunbookAdoptedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { runbookId: string; key: string; name: string; cleared?: boolean }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label={payload.cleared === true ? 'runbook cleared' : 'runbook adopted'}>
        <span data-testid="runbook-name">{payload.name}</span>
      </Transition>
    </ActivityCard>
  )
}

/**
 * What a re-plan actually did (M40 §5).
 *
 * Four counts, worded so the asymmetry ruling R1 is built on cannot be misread: tasks were **added**
 * (they are on the board now), cancellations were **proposed** (nothing was cancelled -- a human
 * approves each one), and the two ways a requested cancellation came to nothing are named apart --
 * **dropped** by the status rule (the task was running, reviewing, done…) and **failed** to become a
 * proposal at all (a cooldown, a switched-off Supervisor, a write that threw).
 *
 * `failedProposals` is read optionally: it joined the payload in Task 3's fix round, and a row
 * written before it carries no such field. Absent is not zero -- rendering "0 failed" for a row that
 * never recorded the number would be an assertion the log does not support -- so that line is simply
 * not there.
 */
function WorkspaceReplannedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    version: number
    added: readonly string[]
    proposedCancellations: readonly string[]
    droppedCancellations: readonly { taskId: string; status: string }[]
    failedProposals?: readonly string[]
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label={`re-planned for goal v${String(payload.version)}`}>
        <span data-testid="replanned-counts">
          <span data-testid="replanned-added">
            {payload.added.length} task{payload.added.length === 1 ? '' : 's'} added
          </span>
          {', '}
          <span data-testid="replanned-proposed">
            {payload.proposedCancellations.length} cancellation{payload.proposedCancellations.length === 1 ? '' : 's'} proposed
          </span>
          {payload.droppedCancellations.length > 0 && (
            <>
              {', '}
              <span data-testid="replanned-dropped">{payload.droppedCancellations.length} dropped</span>
            </>
          )}
          {payload.failedProposals !== undefined && payload.failedProposals.length > 0 && (
            <>
              {', '}
              <span data-testid="replanned-failed">{payload.failedProposals.length} failed</span>
            </>
          )}
        </span>
      </Transition>
    </ActivityCard>
  )
}

/**
 * A task taken off the board (M40 §4) -- by a human, or by a human approving the Supervisor's
 * `cancel_task` proposal.
 *
 * `idle`, not `danger`: a cancellation is not a failure. It carries the reason `cancelTask` kept on
 * the task, and the goal version that task was derived from -- so the log says WHOSE work was
 * dropped without a reader having to join a task row that now says `cancelled` and nothing about
 * why it existed. "unstamped" for a hand-made task, which no goal version produced.
 */
function TaskCancelledCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { reason: string; goalVersion?: number | null }
  const goalVersion = payload.goalVersion ?? null
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="cancelled">
        {/* Another party's text -- a re-plan's own sentence, or an operator's -- as JSX children,
          * so it is characters on the page and never elements (spec §1). */}
        <span data-testid="task-cancelled-reason">{payload.reason}</span>{' '}
        <span data-testid="task-cancelled-goal-version" className="text-text-3">
          {goalVersion === null ? 'unstamped' : `goal v${String(goalVersion)}`}
        </span>
      </Transition>
    </ActivityCard>
  )
}

function WorkspaceCompanyAssignedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    company: string
    // `companySlaveId` is optional here even though the write path (schema.ts) always emits it:
    // pre-M11 rows already stored in the DB have workers without it, and this read path does not
    // schema-validate stored payloads, so the fallback below keeps those legacy rows rendering
    // without duplicate-key warnings.
    workers: ReadonlyArray<{ companySlaveId?: string; name: string; role: string }>
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="company assigned">
        <span data-testid="company-name">{payload.company}</span>
      </Transition>
      {payload.workers.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-text-3">
          {payload.workers.map((worker, index) => (
            <li key={worker.companySlaveId ?? `${worker.name}-${index}`} data-testid="company-worker-item">
              {worker.name} <span className="text-text-3">({worker.role})</span>
            </li>
          ))}
        </ul>
      ) : (
        <p data-testid="company-no-workers" className="mt-1 text-text-3">
          no new workers
        </p>
      )}
    </ActivityCard>
  )
}

// M13 §6.1. `from`/`to` are a `string | number | null` union on the wire because the two fields
// this event covers carry different shapes, and `null` is a REAL value on both -- "no provider
// configured" and "this workspace is not budgeted" -- so it is rendered as a word rather than
// hidden behind a falsy check that would also swallow a budget of `0`.
type SettingsField = 'provider' | 'budgetUsd' | 'supervisorEnabled' | 'supervisorProfile'

/** M38 t2 widened this event to the Supervisor's two settings, so the label is a table rather
 *  than the ternary it was while there were only two fields. */
const SETTINGS_LABEL: Record<SettingsField, string> = {
  provider: 'provider changed',
  budgetUsd: 'budget changed',
  supervisorEnabled: 'supervisor switched',
  supervisorProfile: 'supervisor profile changed',
}

function WorkspaceSettingsChangedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    field: SettingsField
    from: string | number | boolean | null
    to: string | number | boolean | null
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label={SETTINGS_LABEL[payload.field] ?? 'settings changed'}>
        <span data-testid="settings-from">{settingValue(payload.field, payload.from)}</span>
        {' → '}
        <span data-testid="settings-to">{settingValue(payload.field, payload.to)}</span>
      </Transition>
    </ActivityCard>
  )
}

/** `null` is a state an operator chose, not a missing field, so it gets a name of its own. */
function settingValue(field: SettingsField, value: string | number | boolean | null): string {
  if (field === 'supervisorEnabled') return value === true ? 'on' : 'off'
  // A profile is carried as a sha256, never as its text (M38 t2) -- the first eight characters are
  // enough to tell two versions apart, which is all this card is for.
  if (field === 'supervisorProfile') return value === null ? 'none' : `${String(value).slice(0, 8)}\u2026`
  if (value === null) return field === 'provider' ? 'none' : 'no budget'
  return field === 'budgetUsd' ? `$${String(value)}` : String(value)
}

// M27 §3.2: `archiveWorkspace` sets `archivedAt` -- the payload is the footprint the confirm
// showed, so the timeline says exactly what stayed on record. `warn` tone: the project stops
// scheduling from this moment on.
function WorkspaceArchivedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    name: string
    departments: number
    slaves: number
    tasks: number
    runs: number
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="warn" label="project archived">
        <span data-testid="archived-footprint">
          {payload.departments} departments, {payload.slaves} slaves, {payload.tasks} tasks, {payload.runs} runs stay on record
        </span>
      </Transition>
    </ActivityCard>
  )
}

// M27 §3.2: `restoreWorkspace` clears `archivedAt`. `starting` tone, mirroring `WorkspaceCreatedCard`
// -- the project is scheduleable again.
function WorkspaceRestoredCard(props: ActivityCardProps): ReactElement {
  return (
    <ActivityCard {...props}>
      <Transition tone="starting" label="project restored" />
    </ActivityCard>
  )
}

// M23 A1: the first event a workspace ever logs, from `createWorkspace`.
function WorkspaceCreatedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { name: string; repoPath: string; verifyCommands: string[] }
  return (
    <ActivityCard {...props}>
      <Transition tone="starting" label="workspace created">
        <span data-testid="workspace-created-name">{payload.name}</span> · <span className="font-mono">{payload.repoPath}</span> ·{' '}
        {payload.verifyCommands.length} verify command{payload.verifyCommands.length === 1 ? '' : 's'}
      </Transition>
    </ActivityCard>
  )
}

// M23 D1 / M25 §3.1: an operator edited the roster or the departments -- `org.ts`'s control verbs
// (rename/re-role/delete a slave, rename/delete a team, create a project department, move an
// slave to another department) all land here, distinguished by `payload.field`. `idle` tone,
// matching `WorkspaceSettingsChangedCard` above: an edit to configuration, not a run outcome.
const ORG_CHANGED_LABEL: Record<
  'name' | 'role' | 'model' | 'deleted' | 'created' | 'team' | 'capabilities' | 'lifecycle',
  string
> = {
  name: 'renamed',
  role: 'role changed',
  model: 'model changed',
  deleted: 'deleted',
  created: 'created',
  team: 'moved to department',
  // M47: a hire REUSED this worker and merged capability keys into it.
  capabilities: 'capabilities changed',
  // M50 R4: a person moved this worker between permanent, project and ephemeral. Nothing else can.
  lifecycle: 'lifecycle changed',
}

function OrgChangedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    entity: 'slave' | 'team'
    id: string
    field: 'name' | 'role' | 'model' | 'deleted' | 'created' | 'team' | 'capabilities' | 'lifecycle'
    // `createProjectTeam` (field: 'created') carries `from: null` -- the new department had no
    // prior name -- the same nullable shape `to` already has for `deleted`.
    from: string | null
    to: string | null
    // M27 §4.1/§4.2 (ruling R16): the cascade counts `deleteSlave`/`deleteTeam` put on the payload
    // so the timeline says what went down with the row. Both optional in the domain schema, and
    // both absent here on every other field and on every row written before M27 — so the counts
    // line only renders when the event actually carries one.
    runs?: number
    slaves?: number
  }
  const counts =
    payload.field === 'deleted'
      ? [
          payload.slaves === undefined ? null : plural(payload.slaves, 'slave'),
          payload.runs === undefined ? null : plural(payload.runs, 'run'),
        ].filter((part): part is string => part !== null)
      : []
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label={ORG_CHANGED_LABEL[payload.field]}>
        <span data-testid="org-from">{payload.from ?? '—'}</span>
        {' → '}
        <span data-testid="org-to">{payload.to ?? '—'}</span>
        {counts.length > 0 && <span data-testid="org-counts"> · {counts.join(', ')}</span>}
      </Transition>
    </ActivityCard>
  )
}

// M37 t3: the two operator writes the run-context milestone added. Both sit beside `org.changed`
// in the `workspace` filter chip and share its `idle` tone -- a change to how a worker is
// configured, never a run outcome (spec §1 forbids model output from writing either).

/** Which level of the profile override chain was written, in the words the panel uses. */
const PROFILE_TARGET_LABEL: Record<'slave' | 'template' | 'company_slave', string> = {
  slave: 'this worker',
  template: 'its template',
  company_slave: 'its roster row',
}

function SlaveProfileChangedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    target: 'slave' | 'template' | 'company_slave'
    targetId: string
    // `null` is a CLEARED profile -- the level below the written one shows through again.
    sha256: string | null
    actor: string
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label={payload.sha256 === null ? 'profile cleared' : 'profile set'}>
        <span data-testid="profile-target">{PROFILE_TARGET_LABEL[payload.target]}</span>
        {' · by '}
        <span data-testid="profile-actor">{payload.actor}</span>
        {payload.sha256 !== null && (
          // The first 12 characters only: the whole hash says nothing more to a reader, and it is
          // the same prefix the run-context panel shows, so the two can be compared by eye.
          <span data-testid="profile-sha" className="font-mono">
            {' · '}
            {payload.sha256.slice(0, 12)}
          </span>
        )}
      </Transition>
    </ActivityCard>
  )
}

function SlaveRuntimeRolesChangedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { slaveId: string; roles: string[]; actor: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="runtime roles changed">
        {/* An empty set is the parked state (spec §7), and it is exactly what a reader asking
            "why is nothing being dispatched to this worker" came here to see -- so it is said in
            words, not rendered as an empty line. */}
        <span data-testid="runtime-roles">{payload.roles.length === 0 ? 'none (cannot be dispatched)' : payload.roles.join(', ')}</span>
        {' · by '}
        <span data-testid="runtime-roles-actor">{payload.actor}</span>
      </Transition>
    </ActivityCard>
  )
}

// ---- interventions (schema.ts:32-39, 54-59) ----------------------------------------------------
// `event.actor` (human/slave/system) is already on the shared shell's actor badge; these bodies
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

function SlaveMessageSentCard(props: ActivityCardProps): ReactElement {
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
 * M39: a question re-addressed to somebody who can answer it.
 *
 * Nothing was sent, so there is no body to show -- what happened is a MOVE, and its ends are the
 * whole story: away from a role nobody was holding (or a worker who was busy or gone), and to the
 * worker it is now addressed to, by whoever made the call. `from` names a ROLE in words ("the
 * reviewer role") because a role and a worker id are different kinds of thing and a bare
 * `reviewer` beside a `ag-2` reads as though both were workers.
 *
 * The decision id is the link back: a re-address the Supervisor made carries the id every
 * `supervisor.*` row of that decision's life carries, so the proposal, the approval and the move
 * tie together by eye ({@link DecisionRef}, defined with the `supervisor.*` cards below). A human
 * who ran `reassign-question` proposed nothing, so their row carries `null` and shows no link
 * rather than an empty one.
 */
function SlaveMessageReassignedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    messageId: string
    decisionId: string | null
    from: { role: string | null; slaveId: string | null }
    to: { slaveId: string }
    actor: string
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="question re-addressed">
        <span data-testid="reassigned-from" className="font-mono">
          {payload.from.role !== null ? `the ${payload.from.role} role` : (payload.from.slaveId ?? 'nobody')}
        </span>
        {' \u2192 '}
        <span data-testid="reassigned-to" className="font-mono">
          {payload.to.slaveId}
        </span>
        {' \u00b7 by '}
        <span data-testid="reassigned-actor">{payload.actor}</span>
        {payload.decisionId !== null && (
          <>
            {' \u00b7 '}
            <DecisionRef id={payload.decisionId} />
          </>
        )}
      </Transition>
    </ActivityCard>
  )
}

// ---- supervisor.* (schema.ts, M38 t1; the real cards, M38 t5) ---------------------------------
// A decision's full story -- the candidates it chose from, the situation snapshot, the whole
// rationale -- lives on the Supervisor panel and in `supervisor-decisions`. What these five owe
// the timeline is different: enough to make a decision FINDABLE (its short id, repeated on every
// row of its life) and its shape readable at a glance (which situation, on what, chosen how, and
// what happened next). Each renders exactly what its own payload carries and nothing it does not.

/** The first 8 characters of a decision id: enough to tie a run of supervisor.* rows together by
 *  eye, short enough not to swamp the line. */
function DecisionRef({ id }: { readonly id: string }): ReactElement {
  return (
    <span data-testid="supervisor-decision" className="font-mono">
      {id.slice(0, 8)}
    </span>
  )
}

function SupervisorDecidedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    decisionId: string
    situationKind: string
    subjectId: string
    tier: string
    decidedBy: string
    action: { kind: string }
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="supervisor decided">
        <span data-testid="supervisor-situation">{payload.situationKind}</span>
        {' on '}
        {/* The subject, not just the kind: `review_cap_blocked` is a sentence about SOME task, and
          * without the id the row cannot be tied to the task rows around it. */}
        <span data-testid="supervisor-subject" className="font-mono">
          {payload.subjectId}
        </span>
        {' → '}
        <span data-testid="supervisor-action">{payload.action.kind}</span>{' '}
        {/* The tier is what says whether this already happened or is waiting on a human, and the
          * decider whether a model or the rules chose it -- the two things an operator scanning
          * the timeline judges a decision by. */}
        <span data-testid="supervisor-tier" className="text-text-3">
          ({payload.tier}, by {payload.decidedBy})
        </span>
        {' \u00b7 '}
        <DecisionRef id={payload.decisionId} />
      </Transition>
    </ActivityCard>
  )
}

function SupervisorProposedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    decisionId: string
    situationKind: string
    subjectId: string
    action: { kind: string }
    expiresAt: string
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="warn" label="supervisor proposed">
        <span data-testid="supervisor-action">{payload.action.kind}</span>
        {' for '}
        <span data-testid="supervisor-situation">{payload.situationKind}</span>
        {' on '}
        <span data-testid="supervisor-subject" className="font-mono">
          {payload.subjectId}
        </span>
        {' \u00b7 awaiting a human until '}
        {/* The STAMP, not "in 24h": this row is read weeks later as often as live, and a duration
          * computed against now would then describe a proposal that expired long ago. Trimmed to
          * minutes -- `expirePendingDecisions` runs per tick, so seconds are a precision the
          * deadline does not have. */}
        <span data-testid="supervisor-expires" className="font-mono">
          {payload.expiresAt.slice(0, 16).replace('T', ' ')}
        </span>
        {' \u00b7 '}
        <DecisionRef id={payload.decisionId} />
      </Transition>
    </ActivityCard>
  )
}

function SupervisorAppliedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { decisionId: string; action: { kind: string } }
  return (
    <ActivityCard {...props}>
      <Transition tone="working" label="supervisor applied">
        <span data-testid="supervisor-action">{payload.action.kind}</span>
        {' \u00b7 '}
        <DecisionRef id={payload.decisionId} />
      </Transition>
    </ActivityCard>
  )
}

function SupervisorResolvedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    decisionId: string
    outcome: 'approved' | 'rejected' | 'expired'
    reason: string | null
  }
  return (
    <ActivityCard {...props}>
      <Transition tone={payload.outcome === 'approved' ? 'idle' : 'warn'} label={`supervisor ${payload.outcome}`}>
        <DecisionRef id={payload.decisionId} />
        {payload.reason !== null && <span data-testid="supervisor-reason">{` \u00b7 ${payload.reason}`}</span>}
      </Transition>
    </ActivityCard>
  )
}

function SupervisorFailedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { decisionId: string; action: { kind: string }; reason: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="danger" label="supervisor action failed">
        <span data-testid="supervisor-action">{payload.action.kind}</span>
        {' \u00b7 '}
        <span data-testid="supervisor-reason">{payload.reason}</span>
        {' \u00b7 '}
        <DecisionRef id={payload.decisionId} />
      </Transition>
    </ActivityCard>
  )
}

/** M49 R4: knowledge was written down. The TYPE and the STATUS in words (`docs/ia.md` rule 3), with
 *  the id one hover away -- a candidate is a claim and a verified memory is knowledge, and the tone
 *  is what says which. */
function MemoryRecordedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    memoryId: string
    type: MemoryType
    scope: MemoryScope
    status: MemoryStatus
    sourceKind: MemorySourceKind
  }
  return (
    <ActivityCard {...props}>
      <Transition tone={payload.status === 'verified' ? 'idle' : 'working'} label="memory recorded">
        <span data-testid="memory-type" title={payload.type}>{MEMORY_TYPE_LABEL[payload.type]}</span>
        {' · '}
        <span data-testid="memory-status" title={payload.status}>{MEMORY_STATUS_LABEL[payload.status]}</span>
        {' · '}
        <span data-testid="memory-source" title={payload.sourceKind}>{MEMORY_SOURCE_KIND_LABEL[payload.sourceKind]}</span>
      </Transition>
    </ActivityCard>
  )
}

/** M49 R4: a memory moved -- verified, superseded, or withdrawn with a reason. Nothing was deleted. */
function MemoryChangedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { memoryId: string; from: MemoryStatus; to: MemoryStatus; reason?: string }
  return (
    <ActivityCard {...props}>
      <Transition tone={payload.to === 'removed' ? 'warn' : 'idle'} label="memory changed">
        <span data-testid="memory-from" title={payload.from}>{MEMORY_STATUS_LABEL[payload.from]}</span>
        {' → '}
        <span data-testid="memory-status" title={payload.to}>{MEMORY_STATUS_LABEL[payload.to]}</span>
        {payload.reason !== undefined && <span data-testid="memory-reason">{` · ${payload.reason}`}</span>}
      </Transition>
    </ActivityCard>
  )
}

/** M50 R3: a temporary specialist's engagement ended. `idle` tone, for `TaskWorktreeCollectedCard`'s
 *  reason -- this is the organisation tidying up after work that already concluded, not a new
 *  outcome. The count says what was actually removed from disk; the worker's own rows are all
 *  still there, which is the whole ruling. */
function SlaveReleasedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    slaveId: string
    name: string
    reason: string
    worktreesCollected: number
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="released">
        <span data-testid="released-name">{payload.name}</span>
        {' · '}
        <span data-testid="released-reason">{payload.reason}</span>
        {' · '}
        <span data-testid="released-worktrees">{plural(payload.worktreesCollected, 'worktree')} collected</span>
      </Transition>
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
  'run.tool_denied': RunToolDeniedCard,
  'run.paused': RunPausedCard,
  'run.resumed': RunResumedCard,
  'slave.message_sent': SlaveMessageSentCard,
  'slave.message_reassigned': SlaveMessageReassignedCard,
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
  'task.dependency_added': TaskDependencyAddedCard,
  'task.dependency_removed': TaskDependencyRemovedCard,
  'task.review_started': TaskReviewStartedCard,
  'task.review_approved': TaskReviewApprovedCard,
  'task.review_rejected': TaskReviewRejectedCard,
  'task.merge_failed': TaskMergeFailedCard,
  'task.worktree_collected': TaskWorktreeCollectedCard,
  'task.integrated': TaskIntegratedCard,
  'task.unblocked': TaskUnblockedCard,
  'workspace.goal_set': WorkspaceGoalSetCard,
  'workspace.plan_created': WorkspacePlanCreatedCard,
  'workspace.replan_started': WorkspaceReplanStartedCard,
  'workspace.replanned': WorkspaceReplannedCard,
  'task.cancelled': TaskCancelledCard,
  'workspace.company_assigned': WorkspaceCompanyAssignedCard,
  'workspace.settings_changed': WorkspaceSettingsChangedCard,
  'workspace.created': WorkspaceCreatedCard,
  'workspace.archived': WorkspaceArchivedCard,
  'workspace.restored': WorkspaceRestoredCard,
  'org.changed': OrgChangedCard,
  'slave.profile_changed': SlaveProfileChangedCard,
  'slave.runtime_roles_changed': SlaveRuntimeRolesChangedCard,
  'supervisor.decided': SupervisorDecidedCard,
  'supervisor.proposed': SupervisorProposedCard,
  'supervisor.applied': SupervisorAppliedCard,
  'supervisor.resolved': SupervisorResolvedCard,
  'supervisor.failed': SupervisorFailedCard,
  'workspace.runbook_adopted': WorkspaceRunbookAdoptedCard,
  'memory.recorded': MemoryRecordedCard,
  'memory.changed': MemoryChangedCard,
  'slave.released': SlaveReleasedCard,
} satisfies Record<DomainEventType, (props: ActivityCardProps) => ReactElement>
