import { terminateChild } from './process.js'
import type { ChildProcess } from 'node:child_process'
import type { RunOutcome, RuntimeEvent } from '../types.js'

export const DEFAULT_MODEL_TIMEOUT_MS = 120_000

/**
 * How much of a runtime's own error sentence a failure reason carries.
 *
 * 300 characters: the messages worth reading are one or two sentences ("You've hit your monthly
 * spend limit ... your weekly limit resets ..." is 130), and this reason is written into a
 * transcript a person reads. A runtime is free to put a stack trace or a whole HTTP body in that
 * field, and a reason that long stops being an explanation.
 */
const DECISION_ERROR_TEXT_MAX_CHARS = 300

/**
 * What ONE non-interactive model call can come back as. Named `ModelDecisionOutcome` since M31a
 * and unchanged; `packages/control`'s `ModelOutcome` is a structural copy of it (see that type's
 * own comment for why the control layer may not import this package).
 */
export type ModelDecisionOutcome =
  | {
      readonly kind: 'answer'
      readonly text: string
      readonly costUsd: number | null
      readonly tokens: { readonly input: number; readonly output: number } | null
      readonly numTurns: number
    }
  | {
      readonly kind: 'isolation_breach'
      readonly tools: readonly string[]
      readonly costUsd: number | null
      readonly tokens: { readonly input: number; readonly output: number } | null
    }
  | {
      readonly kind: 'failed'
      readonly reason: string
      readonly costUsd: number | null
      readonly tokens: { readonly input: number; readonly output: number } | null
    }

/** What one call's stream amounted to, before it is judged. */
export interface DecisionStream {
  readonly text: string
  readonly tools: readonly string[]
  readonly outcome: RunOutcome | null
  readonly timedOut: boolean
}

/**
 * Reads one decision call's stdout to the end, or until `timeoutMs` elapses, and reports what
 * arrived. Vendor-neutral: `parse` is the runtime's own line parser (`parseStreamLine` for Claude,
 * `parseCursorLine` for Cursor), and nothing else here differs between the two.
 *
 * `child.stdin` is ENDED immediately and its errors are absorbed. A child that exits (or never
 * reads its stdin at all -- a hung fake never touches it) before that write lands turns it into an
 * EPIPE, and with no listener `EventEmitter` throws it back out synchronously and takes the
 * orchestrator down with it. The call's own outcome is still decided below by what actually
 * arrived on stdout. `prompt` is written there when the runtime takes it on stdin (`claude -p`);
 * Cursor takes it as a positional argument and passes nothing.
 */
export async function collectDecisionStream(input: {
  readonly child: ChildProcess
  readonly parse: (line: string) => RuntimeEvent
  readonly timeoutMs?: number | undefined
  readonly prompt?: string | undefined
}): Promise<DecisionStream> {
  const { child, parse } = input
  // A plain mutable object rather than several `let`s: TS's control-flow analysis of a `let`
  // reassigned only inside a nested closure (`handleLine`, called from the `data`/`close`
  // listeners below) narrows the outer reads of that `let` to `never` after the closure runs --
  // reproduced in isolation, not specific to this file -- where a property on a held object
  // narrows correctly.
  const state: { text: string; tools: string[]; outcome: RunOutcome | null } = { text: '', tools: [], outcome: null }
  child.stdin?.on('error', () => {})
  child.stdin?.end(input.prompt ?? '')
  let buffer = ''
  let timedOut = false
  const timer = setTimeout((): void => {
    timedOut = true
    void terminateChild(child, 2_000)
  }, input.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS)
  const handleLine = (line: string): void => {
    if (line.trim() === '') return
    const event = parse(line)
    if (event.kind === 'text') state.text += event.text
    else if (event.kind === 'tool_call') state.tools.push(event.toolName)
    else if (event.kind === 'terminated') state.outcome = event.outcome
  }
  try {
    await new Promise<void>((resolve) => {
      child.stdout?.on('data', (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        lines.forEach(handleLine)
      })
      child.on('close', (): void => {
        if (buffer !== '') handleLine(buffer)
        resolve()
      })
      child.on('error', (): void => resolve())
    })
  } finally {
    clearTimeout(timer)
  }
  return { text: state.text, tools: state.tools, outcome: state.outcome, timedOut }
}

/**
 * The verdict on one collected stream, and the ORDER is the whole of it (M31a controller ruling
 * R2): an isolation breach outranks every other classification, including a timeout or a stream
 * that never produced a result line.
 *
 * The breach is checked FIRST -- a `failed` call is retried and costs a retry; a breach means the
 * hook that was supposed to refuse every tool was defeated or bypassed, and the conservative read
 * of "the model called a tool AND the process then also timed out or crashed" is the breach, not
 * the failure. `fixtures/crash.ndjson`'s first half already contains a `Write` tool_use with no
 * trailing result line -- exactly this case -- and must report `isolation_breach`.
 *
 * `allowedTools` is what a call ASKED FOR, and it is empty for every call but one (F R7). A
 * text-only turn and every Cursor turn get no tools at all, so ANY tool call in the stream is a
 * breach. A read-only turn is spawned with `--tools Read,Glob,Grep` precisely so the model can
 * open a file the person attached, and `--include-hook-events` puts each of those calls in the
 * stream -- judged by the empty-list rule, the one mode that is supposed to read would report a
 * breach every time it did. The tools NOT on the list are still the breach, and the breach names
 * only them.
 *
 * One function for both runtimes, deliberately: a rule about what counts as a breach that held on
 * one provider and not the other would be a rule nobody could state.
 */
export function classifyDecision(stream: DecisionStream & { readonly allowedTools?: readonly string[] }): ModelDecisionOutcome {
  const { text, tools, outcome, timedOut } = stream
  const allowed = new Set(stream.allowedTools ?? [])
  const unexpected = tools.filter((tool) => !allowed.has(tool))
  const costUsd = outcome?.costUsd ?? null
  const tokens = outcome?.tokens ?? null
  if (unexpected.length > 0) return { kind: 'isolation_breach', tools: unexpected, costUsd, tokens }
  if (timedOut) return { kind: 'failed', reason: 'timeout', costUsd, tokens }
  if (outcome === null) return { kind: 'failed', reason: 'the model process ended without a result line', costUsd, tokens }
  if (outcome.isError) {
    // BOTH halves: the category, which anything matching on this reason already reads, and the
    // runtime's own sentence, which is the only part that says whether the failure is worth
    // waiting out. Bounded, because this reason travels into a transcript a person reads and a
    // runtime is free to put a wall of text in that field.
    const said = outcome.errorText === null ? '' : ` — ${outcome.errorText.slice(0, DECISION_ERROR_TEXT_MAX_CHARS)}`
    return { kind: 'failed', reason: `result is_error: ${outcome.terminalReason}${said}`, costUsd, tokens }
  }
  return { kind: 'answer', text, costUsd, tokens, numTurns: outcome.numTurns }
}
