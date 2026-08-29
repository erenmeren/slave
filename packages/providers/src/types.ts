/**
 * Which runtime a run is on. A plain string union, not a re-export of the Postgres enum
 * (`packages/db`'s generated `ProviderKind`) -- `packages/providers` does not depend on
 * `@ai-team-os/db` at runtime (it is a devDependency only, for test fixtures), and this type is
 * the package's own vocabulary for it, kept in sync with the Prisma enum's literal spellings by
 * hand. `'cursor'` has no adapter yet (M12 Series D); it exists here because `signalPause`
 * (`pause-signal.ts`) already dispatches on it.
 */
export type ProviderKind = 'claude_code' | 'cursor'

/**
 * Every member of `ProviderKind`, as data (M12 Task 13 fix round 1). The canonical source for any
 * SERVER-side caller that needs to enumerate the kinds to validate an untrusted string --
 * `packages/control/src/org.ts`'s `isProviderKind` is the reason this exists. A hand rolled list
 * with no link back to the type is exactly the failure this guards against: a third kind added to
 * the union above without a matching entry here now fails the BUILD (see
 * `_ProviderKindsComplete` below) instead of leaving a validator silently two-wide. Mirrors
 * `capabilitiesOf`'s own `const unhandled: never` idiom (`capabilities.ts`) -- one canonical
 * table beats several that agree today.
 *
 * NOT re-exported for CLIENT use: `apps/web/src/components/ProviderSelect.tsx` carries its own
 * copy of this exact list, guarded by the identical `satisfies`/`Exclude` idiom, because a value
 * import of anything from this package's barrel (`index.ts`) drags `claude/adapter.ts` and
 * `cursor/adapter.ts` -- both `node:child_process` at module scope -- into whatever bundles it,
 * and neither adapter has a `sideEffects: false` escape hatch. Two independently-guarded lists,
 * not one shared value, is the deliberate trade against that risk; see `ProviderSelect.tsx`'s own
 * docstring for the client half of this reasoning.
 */
export const PROVIDER_KINDS = ['claude_code', 'cursor'] as const satisfies readonly ProviderKind[]

// Compile-time completeness check: `satisfies` above proves every element of `PROVIDER_KINDS` is
// a `ProviderKind` (soundness); this proves the reverse -- every `ProviderKind` is IN
// `PROVIDER_KINDS` (completeness) -- so omitting a member is a build error, not a silent gap.
type _AssertNever<T extends never> = T
type _ProviderKindsComplete = _AssertNever<Exclude<ProviderKind, (typeof PROVIDER_KINDS)[number]>>

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
  /**
   * USD, or `null` when the runtime does not report spend. Never `0` for an unmeasured
   * run -- zero is a figure the budget guardrail believes.
   */
  readonly costUsd: number | null
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
