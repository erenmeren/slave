/**
 * `RunOutcome` is the normalized shape of the CLI's terminal `result` event.
 * Field names follow the domain's camelCase convention; the raw stream uses
 * snake_case (`is_error`, `total_cost_usd`, ...).
 */
export interface RunOutcome {
  readonly isError: boolean
  readonly terminalReason: string
  readonly stopReason: string | null
  readonly numTurns: number
  readonly costUsd: number
  readonly deniedToolUseIds: readonly string[]
}

/**
 * The adapter's vocabulary. `parseStreamLine` turns one NDJSON line from the
 * `claude` CLI into exactly one of these.
 *
 * `hook_crashed` and `hook_failed_open` are separate variants on purpose
 * (spec §5.3, §13.1): the first means the run stopped, the second means it
 * kept going with no gate. `ignored` is a recognized line this parser does
 * not act on -- it is distinct from `unparsable`, which means the line
 * could not be understood at all.
 */
export type RuntimeEvent =
  | { readonly kind: 'session_started'; readonly sessionId: string }
  | { readonly kind: 'tool_call'; readonly toolUseId: string; readonly toolName: string; readonly summary: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'hook_denied'; readonly hookName: string; readonly reason: string }
  | {
      readonly kind: 'hook_crashed'
      readonly hookName: string
      readonly exitCode: number
      readonly stderr: string
    }
  | {
      readonly kind: 'hook_failed_open'
      readonly hookName: string
      readonly exitCode: number
      readonly stderr: string
    }
  | { readonly kind: 'permission_denied'; readonly toolName: string; readonly toolUseId: string }
  | { readonly kind: 'terminated'; readonly outcome: RunOutcome }
  | { readonly kind: 'ignored'; readonly line: string }
  | { readonly kind: 'unparsable'; readonly line: string }
