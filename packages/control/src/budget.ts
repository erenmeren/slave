import { capabilitiesOf, type ProviderCapabilities, type ProviderKind } from '@slave-of-ai/providers'
import type { ControlRefusal } from './refusal.js'

/**
 * May a run on this provider start in this workspace? (spec §6, Decision 7; M12 Task 9.)
 *
 * M27 §3.3: an archived project refuses first, ahead of the budget rule below -- once a project is
 * archived nothing may dispatch into it, budgeted or not, so there is no ordering in which the
 * budget check would ever need to be reached.
 *
 * A budgeted workspace will not accept a runtime that cannot report what it spends. The guardrail
 * is real or it is absent, never silently inert: a `budgetUsd` that no run can ever move is worse
 * than no budget at all, because an operator reads it as protection they do not have.
 *
 * Pure and synchronous, taking a kind's capabilities rather than an adapter, because NEITHER of
 * the two places that must ask this question can reach a live adapter. `packages/control`'s write
 * surface has no `AdapterRegistry` (a registry is an orchestrator-process concept, built per
 * deployment), and at write time there is no run to resolve one for; the orchestrator's dispatch
 * holds a kind before it holds a process. Callers get the capabilities from `capabilitiesOf`, the
 * one table -- see `admitProvider` below for the convenience form that does that itself.
 *
 * `budgetUsd: 0` is a budget an operator SET, and is refused as firmly as any other. Only `null`
 * -- the deliberate "this workspace is not budgeted" state `Workspace.budgetUsd` gained in this
 * task, against a `@default(20)` that keeps every ordinary workspace budgeted -- admits a
 * cost-blind runtime.
 *
 * The result shape is the plan's own (`{ ok: true } | { ok: false; refusal }`) rather than
 * `packages/domain`'s `Result`, kept deliberately distinct: every caller here is inside a function
 * that ALREADY returns a `Result<_, ControlRefusal>`, and `if (!admission.ok) return
 * err(admission.refusal)` reads as the handoff it is instead of a value being passed through
 * unexamined.
 */
export function admitRun(input: {
  readonly workspace: { readonly id: string; readonly budgetUsd: number | null; readonly archivedAt: Date | null }
  readonly provider: ProviderKind
  readonly capabilities: Pick<ProviderCapabilities, 'reportsCost'>
}): { readonly ok: true } | { readonly ok: false; readonly refusal: ControlRefusal } {
  // M27 §3.3/§8: checked before the budget rule -- a tick that loaded the world just before an
  // archive must not be able to dispatch into it after.
  //
  // This check alone cannot promise that, and never could: it reads the `Workspace` row the caller
  // loaded, so an archive committing after that load is invisible to it. What closes the window is
  // the orchestrator's `createRunUnlessArchived` (ruling R15), which re-reads `archivedAt` under
  // `FOR SHARE` in the transaction that inserts the `SlaveRun` row -- a lock that DOES conflict
  // with `archiveWorkspace`'s `FOR UPDATE`. This stays as the cheap in-memory refusal in front of
  // it, and as the rule the write surfaces share.
  if (input.workspace.archivedAt !== null) {
    return { ok: false, refusal: { kind: 'workspace_archived', workspaceId: input.workspace.id } }
  }
  if (input.workspace.budgetUsd === null) return { ok: true }
  if (input.capabilities.reportsCost) return { ok: true }
  return {
    ok: false,
    refusal: { kind: 'unmeasurable_budget', workspaceId: input.workspace.id, provider: input.provider },
  }
}

/**
 * `admitRun` with the capability lookup done for you -- the form every real call site uses, since
 * all of them have a `ProviderKind` and none of them have a reason to consult a different table
 * than `capabilitiesOf`. Kept as a thin wrapper rather than folded into `admitRun` so the
 * admission RULE stays testable against a hand-written capability, independently of what the
 * table currently says about any particular kind.
 */
export function admitProvider(
  workspace: { readonly id: string; readonly budgetUsd: number | null; readonly archivedAt: Date | null },
  provider: ProviderKind,
): { readonly ok: true } | { readonly ok: false; readonly refusal: ControlRefusal } {
  return admitRun({ workspace, provider, capabilities: capabilitiesOf(provider) })
}
