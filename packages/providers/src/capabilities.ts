import { PROVIDER_KINDS, manifestFor, type ProviderCapabilityManifest, type ProviderKind } from '@slave-of-ai/domain'
import type { ProviderCapabilities } from './contract/adapter.js'

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
 *
 * SINCE M56a R4 THE ROWS ARE A PROJECTION, not a table. Five members, five axes of the provider's
 * own manifest (`packages/domain/src/provider/manifest.ts`), computed ONCE at module load: the
 * function still answers without constructing an adapter, still answers the same object every time
 * -- `ClaudeCodeAdapter.getCapabilities()` delegates here and `capabilities.test.ts` asserts the two
 * are the same object, not merely equal -- and the values are byte-identical to the two frozen rows
 * this replaced, which `scripts/fixtures/m56a-goldens/capabilities.json` pins from before the
 * migration.
 *
 * The `const unhandled: never` guard that used to live in this switch is not lost; it moved one
 * level down, onto `PROVIDER_MANIFESTS`' own totality (`Record<ProviderKind, …>`), where a third
 * kind with no row is a build error for EVERY axis at once rather than for this one switch. What
 * stays here is the runtime refusal for a kind that reached this function through an unchecked cast.
 */
export function capabilitiesOf(kind: ProviderKind): ProviderCapabilities {
  const capabilities = CAPABILITIES_BY_KIND[kind]
  if (capabilities === undefined) {
    throw new Error(`capabilitiesOf: unhandled provider kind ${JSON.stringify(kind)}`)
  }
  return capabilities
}

/**
 * R4's projection, member by member, with the axis each one reads:
 *
 *   `canPauseMidRun`     `pause.rung === 'hook'` -- ADR 0001's top rung is the only one that stops
 *                        a run between tool calls and leaves it resumable in place.
 *   `canResumeSession`   `resume.mode !== 'none'`.
 *   `gate`               `'none'` when there is no mechanism at all, `'all-tools'` otherwise.
 *                        **`'shell-only'` is unreachable and stays so**: it was superseded by proof
 *                        at M13 Task 9, and this file's own widen-never-narrow rule forbids
 *                        narrowing a value already recorded. `ShellOnlyMark.tsx` therefore stays
 *                        exactly as it is, dead and correct (`docs/ia.md` rule 2).
 *   `reportsCost`        `usageCost === 'reported'`.
 *   `reportsToolResults` `events.produces.includes('tool_result')`.
 */
function project(manifest: ProviderCapabilityManifest): ProviderCapabilities {
  return {
    canPauseMidRun: manifest.pause.rung === 'hook',
    canResumeSession: manifest.resume.mode !== 'none',
    gate: manifest.toolRestrictions.mechanism === 'none' ? 'none' : 'all-tools',
    reportsCost: manifest.usageCost === 'reported',
    reportsToolResults: manifest.events.produces.includes('tool_result'),
  }
}

/*
 * THE CLAUDE ROW'S MEASUREMENT HISTORY -- ADR 0001's measured `ProviderCapabilities` for the Claude
 * Code adapter, which is what `CLAUDE_CODE_MANIFEST`'s five axes now hold
 * (`packages/domain/src/provider/claude-code.ts`). The values did not move; where they are written
 * down did.
 *
 * `reportsToolResults: true` is M51 R6, and PROVEN, not assumed: `claude/stream.ts`'s
 * `parseUserLine` reads a `tool_result` event off the `user` lines of
 * `test/fixtures/complete.ndjson` -- a recording of the real CLI -- and the PostToolUse tap fills
 * any gap those lines leave. A capability here is only ever widened by proof (see the Cursor row
 * below for the rule stated in full).
 */

/*
 * THE CURSOR ROW'S MEASUREMENT HISTORY -- PROVEN against the installed binary in M13 Task 9 and no
 * longer conservative. These are the five axes `CURSOR_MANIFEST` now holds
 * (`packages/domain/src/provider/cursor.ts`), and this is the reasoning that lets a reader trust
 * them.
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
 * `reportsToolResults: true` is M51 R6, and WIDENED by proof exactly as the rule below requires:
 * the `completed` half of a `tool_call` line carries the call's own result under `result.success` /
 * `result.rejected` (`test/fixtures/cursor/cursor-run.ndjson` line 8, and
 * `.../gate/run-2-flag-present.ndjson` for the other shape), and `cursor/stream.ts` reads it as a
 * `tool_result`. Cost-blind is not result-blind: Cursor needs no tap, because its own stream
 * already says what came back.
 *
 * Measured on `cursor-agent 2026.08.25-3e8eec8` only -- the binary self-updates, and the fixture
 * README under `packages/providers/test/fixtures/cursor/gate/` records the version per payload.
 * Only a shell call and an edit call were measured; no MCP or subagent tool call was exercised.
 *
 * A capability here may only ever be WIDENED by proof, never narrowed: it may not be set to a value
 * stricter than what is already recorded, because narrowing it retroactively invalidates a
 * configuration an operator was already told was acceptable. A later measurement that appears to
 * warrant narrowing a value is evidence of a regression to investigate, not a reason to edit the
 * manifest.
 */

/**
 * One row per kind, computed at module load and FROZEN.
 *
 * Computed once and not per call for a reason a test states: `capabilities.test.ts:36-42` asserts
 * `adapter.getCapabilities()` IS `capabilitiesOf('claude_code')` -- identity, because "two frozen
 * objects that happen to agree today would satisfy `toEqual` and still drift apart on the first
 * edit to either one". A projection computed per call would hand out a fresh object every time and
 * break exactly the assertion that proves there is one table.
 */
const CAPABILITIES_BY_KIND: Record<ProviderKind, ProviderCapabilities> = Object.fromEntries(
  PROVIDER_KINDS.map((kind) => [kind, Object.freeze(project(manifestFor(kind)))]),
) as Record<ProviderKind, ProviderCapabilities>
