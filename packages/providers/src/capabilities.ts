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

// TASK 12: verified against the installed cursor-agent, not assumed
/**
 * Cursor's row, declared here at spec §7's own CONSERVATIVE values ahead of the adapter that will
 * prove them (M12 Task 12 / Series D). Spec §7's rule is explicit: a capability that cannot be
 * proven takes its conservative value -- `false` for a boolean, `'none'` for a gate -- and is
 * never assumed true because a vendor's documentation says so. `gate: 'shell-only'` is the value
 * the spec itself states for Cursor rather than a proven one; it is strictly narrower than
 * `'all-tools'` and is not read by any admission check in this task.
 *
 * Declaring these EARLY is safe in exactly one direction. Task 12 may flip a `false` to `true`
 * after proving it against the binary, and every such flip only ever WIDENS what is admitted --
 * so nothing that passes today can start failing later. It may never narrow a value, because that
 * would retroactively invalidate a configuration an operator was already told was acceptable.
 */
const CURSOR_CAPABILITIES: ProviderCapabilities = {
  canPauseMidRun: false,
  canResumeSession: true,
  gate: 'shell-only',
  reportsCost: false,
}
