import { describe, expect, it } from 'vitest'
import { admitRun, refusalText } from '@slave-of-ai/control'
import { capabilitiesOf } from '@slave-of-ai/providers'

/**
 * Spec Decision 7 as a pure function (M12 Task 9). A workspace with a `budgetUsd` will not accept
 * a runtime that cannot report what it spends: the guardrail is real or it is absent, and there is
 * no silently inert middle where a budget exists and nothing can ever enforce it.
 *
 * Pure and synchronous on purpose -- both callers that need it are structurally unable to reach a
 * live adapter (`packages/control`'s write surface has no registry; the orchestrator's dispatch
 * has a kind before it has a process), so this decision has to be answerable from a kind and a
 * column alone.
 */
describe('admitRun', () => {
  const WORKSPACE_ID = 'ws-1'

  it('refuses to dispatch a cost-blind provider into a budgeted workspace', () => {
    const result = admitRun({
      workspace: { id: WORKSPACE_ID, budgetUsd: 20 },
      provider: 'cursor',
      capabilities: { reportsCost: false },
    })
    expect(result).toEqual({
      ok: false,
      refusal: { kind: 'unmeasurable_budget', workspaceId: WORKSPACE_ID, provider: 'cursor' },
    })
  })

  it('refuses with the spec-verbatim unmeasurable_budget text', () => {
    // Compared against `refusalText()` itself, not a hand-copied string, so the two cannot drift
    // -- and asserted on the TEXT rather than only on `ok: false`, because a check that
    // `throw new Error('boom')` would satisfy is not a check (Task 8's fix round F3).
    const result = admitRun({
      workspace: { id: WORKSPACE_ID, budgetUsd: 0.01 },
      provider: 'cursor',
      capabilities: { reportsCost: false },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(refusalText(result.refusal)).toBe('a budget needs a provider that reports cost')
  })

  it('admits a cost-blind provider when the workspace has no budget', () => {
    const result = admitRun({
      workspace: { id: WORKSPACE_ID, budgetUsd: null },
      provider: 'cursor',
      capabilities: { reportsCost: false },
    })
    expect(result).toEqual({ ok: true })
  })

  it('admits a cost-reporting provider into a budgeted workspace', () => {
    const result = admitRun({
      workspace: { id: WORKSPACE_ID, budgetUsd: 20 },
      provider: 'claude_code',
      capabilities: { reportsCost: true },
    })
    expect(result).toEqual({ ok: true })
  })

  it('refuses a budget of zero as firmly as any other budget', () => {
    // `0` is a budget an operator set, not an absent one. Only `null` is absent -- conflating the
    // two would let a cost-blind runtime into the most tightly budgeted workspace there is.
    const result = admitRun({
      workspace: { id: WORKSPACE_ID, budgetUsd: 0 },
      provider: 'cursor',
      capabilities: { reportsCost: false },
    })
    expect(result).toMatchObject({ ok: false, refusal: { kind: 'unmeasurable_budget' } })
  })

  it('reads the same capability table the adapters answer from', () => {
    // The admission is only as honest as the table it consults; wiring it to `capabilitiesOf` here
    // is what proves the two real call sites are asking the same question this test asks.
    expect(
      admitRun({
        workspace: { id: WORKSPACE_ID, budgetUsd: 20 },
        provider: 'cursor',
        capabilities: capabilitiesOf('cursor'),
      }),
    ).toMatchObject({ ok: false })
    expect(
      admitRun({
        workspace: { id: WORKSPACE_ID, budgetUsd: 20 },
        provider: 'claude_code',
        capabilities: capabilitiesOf('claude_code'),
      }),
    ).toEqual({ ok: true })
  })
})
