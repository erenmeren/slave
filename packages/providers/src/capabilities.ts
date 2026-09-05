import type { ProviderCapabilities } from './claude/adapter.js'
import type { ProviderKind } from './types.js'

/**
 * What each provider kind can promise, as a PURE lookup on the kind alone (M12 Task 9).
 *
 * This exists because both of the milestone's budget-admission points have to ask "does kind K
 * report what it spends?" and neither of them can construct an adapter to ask:
 * `packages/control`'s write surface has no `AdapterRegistry` (a registry is an
 * orchestrator-process concept, built per deployment from whichever adapters that process was
 * given), and write time has no run to resolve one for. A capability question that can only be
 * answered by an instance is therefore unanswerable exactly where the milestone needs it answered.
 *
 * Nothing here constructs an adapter, reads options, spawns a process, or touches the filesystem
 * -- a capability is a fact about a KIND, not about a live instance, which is why it can be
 * hoisted out of the class at all.
 *
 * `ClaudeCodeAdapter.getCapabilities()` delegates here rather than holding its own copy, so there
 * is ONE table. Two tables that agree today are two tables that disagree after the first edit,
 * and the disagreement would be invisible: the admission check would read one and the pause
 * strategy the other.
 */
export function capabilitiesOf(kind: ProviderKind): ProviderCapabilities {
  switch (kind) {
    case 'claude_code':
      return CLAUDE_CODE_CAPABILITIES
    case 'cursor':
      return CURSOR_CAPABILITIES
    default: {
      // The `pause-signal.ts` idiom (the Task 3 -> Task 8 ruling, fix round 2). `tsconfig.base`
      // sets `strict` but not `noImplicitReturns`, so a third `ProviderKind` added to the union
      // would fall out of this switch and return `undefined` -- a provider whose capabilities
      // read as "no capabilities at all" to every consumer, including a budget admission that
      // would then throw on a property of undefined rather than refuse. Binding `kind` to `never`
      // makes that a BUILD failure naming the unhandled member.
      const unhandled: never = kind
      throw new Error(`capabilitiesOf: unhandled provider kind ${JSON.stringify(unhandled)}`)
    }
  }
}

/** ADR 0001's measured `ProviderCapabilities` for the Claude Code adapter, verbatim. */
const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  canPauseMidRun: true,
  canResumeSession: true,
  gate: 'all-tools',
  reportsCost: true,
}

/**
 * Cursor's row, PROVEN against the installed binary in M13 Task 9 and no longer conservative.
 *
 * `gate: 'all-tools'` because the recorded run at
 * `packages/providers/test/fixtures/cursor/gate/run-2-flag-present.ndjson` shows BOTH a shell
 * command and a file write refused through the `preToolUse` registration while the pause flag was
 * present, with the control run (flag absent) showing both succeeding. M12 spec §7's premise --
 * "Cursor fires only the shell hooks" -- is superseded and false; `preToolUse` fires for `Read`,
 * `Write` and `Shell` alike.
 *
 * That `preToolUse` registration has no `matcher`, and the recording shows this is LOAD-BEARING,
 * not merely cautious: the write above was stopped at a `preToolUse` invocation whose `tool_name`
 * was `"Read"`, not `"Write"` -- Cursor's edit tool reads its target before writing it, and both
 * steps are gated under the edit call's own id, so the write never reached a `tool_name: "Write"`
 * invocation at all. A matcher scoped to (say) `^(Write|Shell)$`, which reads as an obviously safe
 * narrowing, would have let this exact write through. See `cursor/hooks.ts` for the full
 * reasoning behind the no-matcher registration.
 *
 * `canPauseMidRun` stays `false`: there is still no mechanism that stops the slave between tool
 * calls and leaves it resumable in place. The gate refuses calls; it does not suspend the run.
 * `reportsCost` stays `false`: the `result` line carries no cost figure at all.
 *
 * Measured on `cursor-agent 2026.08.25-3e8eec8` only -- the binary self-updates, and the fixture
 * README under `packages/providers/test/fixtures/cursor/gate/` records the version per payload.
 * Only a shell call and an edit call were measured; no MCP or subagent tool call was exercised.
 *
 * A capability in this table may only ever be WIDENED by proof, never narrowed: it may not be set
 * to a value stricter than what is already recorded here, because narrowing it retroactively
 * invalidates a configuration an operator was already told was acceptable. A later measurement
 * that appears to warrant narrowing a value is evidence of a regression to investigate, not a
 * reason to edit this table.
 */
const CURSOR_CAPABILITIES: ProviderCapabilities = {
  canPauseMidRun: false,
  canResumeSession: true,
  gate: 'all-tools',
  reportsCost: false,
}
