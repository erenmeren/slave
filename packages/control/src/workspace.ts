import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { PROVIDER_KINDS, type ProviderKind } from '@ai-team-os/providers'
import type { ControlRefusal } from './refusal.js'

/** Validates an UNTRUSTED provider string (a CLI flag, a web request body), like `org.ts`'s copy. */
function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value)
}

/**
 * Sets (or clears) the workspace's default runtime -- the last link of `resolveRuntime`'s override
 * chain, and until M13 a row nothing in this codebase could write.
 *
 * ONE TRANSACTION, DELETE-THEN-INSERT (Decision 9). `workspaceDefaultProvider` returns a default
 * only for a workspace with EXACTLY ONE `ProviderConfiguration` row -- more than one and it
 * returns `null`, because the table has no "this one is the default" column, so picking one would
 * be an arbitrary choice dressed up as a default. An upsert on `(workspaceId, kind)` would create
 * a SECOND row when the kind changes, which would silently stop every dispatch in the workspace.
 * Replacing is the only shape that keeps the rule true.
 *
 * `null` deletes: "this workspace has no configured default", which is a real state and not the
 * same as "the operator configured Claude".
 *
 * Deliberately NOT refused for a halted workspace (Decision 11) and deliberately NOT checked
 * against `Workspace.budgetUsd` (Decision 10): a cost-blind provider on a budgeted workspace is a
 * configuration dispatch refuses with `unmeasurable_budget`, and duplicating that refusal here
 * would make the pair unreachable in the order (provider first, budget second) an operator
 * naturally uses -- while telling them the same thing twice.
 */
export async function setWorkspaceProvider(
  workspaceId: string,
  kind: ProviderKind | null,
): Promise<Result<void, ControlRefusal>> {
  if (kind !== null && !isProviderKind(kind)) return err({ kind: 'invalid_provider', provider: kind })

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const outcome = await prisma.$transaction(async (tx) => {
    // ONE WRITER AT A TIME (I1). Delete-then-insert is only "exactly one row or nothing" if nobody
    // else is between the two statements, and under READ COMMITTED nothing else here serialises
    // them: neither `deleteMany` sees the other transaction's uncommitted `create`, and
    // `@@unique([workspaceId, kind])` does not collide when the two writers pick DIFFERENT kinds.
    // Two concurrent kind changes therefore both delete nothing and both insert, leaving two rows
    // -- at which point `workspaceDefaultProvider` returns null and every dispatch in the workspace
    // throws, burning an attempt per task per tick (Task 3's `releaseTaskAfterFailure`). Locking the
    // `Workspace` row makes the second writer wait for the first to COMMIT, so its `deleteMany`
    // sees the committed row and replaces it. The lock is taken on the parent row rather than on
    // `ProviderConfiguration` because the rows being serialised are the ones that may not exist yet.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    // The workspace can be deleted between the read above and this lock; zero locked rows is the
    // same answer that read gives, spelled the same way.
    if (locked.length === 0) return { locked: false } as const

    const existing = await tx.providerConfiguration.findMany({ where: { workspaceId }, select: { kind: true } })
    await tx.providerConfiguration.deleteMany({ where: { workspaceId } })
    if (kind !== null) {
      // `settings: {}` -- the column has no reader anywhere in this codebase, and inventing a
      // shape for it now, with nothing to pass it to, is the mistake M12 Task 5 already caught
      // once. An empty object is the honest "nothing configured".
      await tx.providerConfiguration.create({ data: { workspaceId, kind, settings: {} } })
    }
    // The same "exactly one row or nothing" rule `workspaceDefaultProvider` reads by: a workspace
    // that somehow held two rows had no resolvable default, so `from` is honestly `null`.
    return { locked: true, from: existing.length === 1 ? existing[0]!.kind : null } as const
  })
  if (!outcome.locked) return err({ kind: 'workspace_not_found', workspaceId })
  const from = outcome.from

  await appendEvent({
    type: 'workspace.settings_changed',
    workspaceId,
    actor: 'human',
    payload: { field: 'provider', from, to: kind },
  })
  return ok(undefined)
}

/**
 * Sets (or clears) the workspace's spend ceiling.
 *
 * `null` is the deliberate "this workspace is not budgeted" state -- spec §6's ONLY state in which
 * a cost-blind runtime may run. `0` is a budget an operator SET and is refused at dispatch as
 * firmly as any other figure, so it is accepted here.
 *
 * `Number.isFinite` rather than a bare `>= 0` check: `NaN >= 0` is `false` (so NaN is caught
 * either way) but `Infinity >= 0` is `true`, and an infinite ceiling written into a Float column
 * is a budget that can never be exceeded -- a guardrail that is silently inert, which is exactly
 * the shape M12 made this column nullable to avoid.
 */
export async function setWorkspaceBudget(
  workspaceId: string,
  usd: number | null,
): Promise<Result<void, ControlRefusal>> {
  if (usd !== null && (!Number.isFinite(usd) || usd < 0)) return err({ kind: 'invalid_budget' })

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, budgetUsd: true },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  await prisma.workspace.update({ where: { id: workspaceId }, data: { budgetUsd: usd } })
  await appendEvent({
    type: 'workspace.settings_changed',
    workspaceId,
    actor: 'human',
    payload: { field: 'budgetUsd', from: workspace.budgetUsd, to: usd },
  })
  return ok(undefined)
}
