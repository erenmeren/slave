import { prisma } from '@slave-of-ai/db/client'
import { resolveOverride } from '@slave-of-ai/domain'
import type { ProviderKind } from '@slave-of-ai/providers'

/**
 * The pair a run is dispatched with (M12 §5). `resolveRuntime` replaces `resolveModel` (M10 §6):
 * the override chain is the same one -- the SEAT's own columns win over the PERSON's (M58 R7,
 * where the roster row used to sit), which win over their persona's default, which falls back to
 * the workspace's own configured default when every link above is unset -- but the chain carries
 * the PROVIDER alongside the model, from the same level, never from two different ones (spec
 * Decision 5).
 *
 * `provider: null` in the result is a refusal, not "assume Claude" -- the caller must check it
 * before dispatching and treat a null the way it treats any other reason a run cannot start. It
 * arises two ways:
 *
 * 1. Nothing in the chain names a model, and `workspaceDefault` (the chain's last link, read by
 *    `workspaceDefaultProvider` below) is itself `null` -- the workspace has no configured default
 *    and nothing above it named one either.
 * 2. A HALF-PAIR: some level names a model but has no provider recorded for it. This is possible
 *    only on a row written before M12 existed -- Task 7 made writing a model without its provider
 *    a refusal at every level this chain reads (`packages/control/src/org.ts`), but it could not
 *    repair a row that predates the guard (`SlaveTemplate` is append-only). When this level is
 *    reached, two silent moves are both available and both wrong:
 *    falling through to a LOWER level's provider would pair THIS level's model with a provider
 *    nobody ever chose for it (the exact "incompatible combination" Decision 5 says must be
 *    unable to be expressed); falling through to a lower level's MODEL as well would silently
 *    discard the one thing an operator actually set on this level. Both are the class of silent
 *    substitution this milestone exists to remove, so the half-pair is unresolvable: refused, not
 *    repaired here, not guessed at.
 *
 * A seat whose person is not loaded (`person: null`) resolves through its own columns alone, same
 * as `resolveModel` did -- there is nothing else to consult.
 */
export interface ResolvedRuntime {
  readonly provider: ProviderKind | null
  readonly model: string | undefined
}

/** M58 R7: the three levels of the chain, as `resolveRuntime` reads them. `person` is null only
 *  where the caller has not loaded one -- every seat has a person. */
export interface RuntimeLevels {
  readonly model: string | null
  readonly provider: ProviderKind | null
  readonly person: {
    readonly model: string | null
    readonly provider: ProviderKind | null
    readonly template: { readonly defaultModel: string | null; readonly provider: ProviderKind | null } | null
  } | null
}

/** One rung of the ladder, and never half of one. A rung EXISTS for `resolveOverride` only when it
 *  names a model: a level with no model has nothing to name, and its provider column -- if somehow
 *  set -- names nothing to run and is not consulted (Task 7's write guard makes "provider set,
 *  model unset" unwritable going forward). Pairing the two INTO the rung is what keeps Decision 5's
 *  rule true: the provider that comes back is always the provider of the level whose model came
 *  back with it, and never a lower level's. */
type RuntimeRung = { readonly model: string; readonly provider: ProviderKind | null }

const rung = (model: string | null, provider: ProviderKind | null): RuntimeRung | null =>
  model === null ? null : { model, provider }

export function resolveRuntime(levels: RuntimeLevels, workspaceDefault: ProviderKind | null): ResolvedRuntime {
  const chosen = resolveOverride<RuntimeRung>({
    seat: rung(levels.model, levels.provider),
    person: rung(levels.person?.model ?? null, levels.person?.provider ?? null),
    template: rung(levels.person?.template?.defaultModel ?? null, levels.person?.template?.provider ?? null),
  })

  if (chosen === null) return { provider: workspaceDefault, model: undefined }
  // The half-pair case (see the docstring above): this level names a model with no provider.
  // Refused here, at the level that has the problem, rather than falling through to any other.
  return { provider: chosen.value.provider, model: chosen.value.provider === null ? undefined : chosen.value.model }
}

/**
 * The workspace's default runtime -- the chain's last link (M12 §5), read from
 * `ProviderConfiguration` (`schema.prisma`'s table, added at M3 and unread by any production code
 * until this function).
 *
 * Deliberately returns a bare `ProviderKind`, not the brief's sketched `{ kind, settings }`:
 * `ProviderConfiguration.settings` has no reader anywhere in this codebase (`AdapterSettings` was
 * dropped as YAGNI at Task 5 for the identical reason -- zero consumers), and `AdapterRegistry.
 * resolve` takes only a `ProviderKind`, nothing else. Inventing a settings shape now, with nothing
 * to pass it to, would repeat the exact mistake Task 5 already caught once. Widening this to also
 * return `settings` is a one-line, backward-compatible change for whichever task actually threads
 * per-workspace adapter options into the registry.
 *
 * A workspace with exactly one `ProviderConfiguration` row uses that row's kind. A workspace with
 * NONE has no default -- `null`, never `'claude_code'`: assuming Claude here is precisely the
 * silent fallback this milestone exists to remove, the moment a caller can no longer tell "the
 * operator configured Claude" from "the operator configured nothing." A workspace with MORE THAN
 * ONE row is refused the same way: the table has no "this one is the default" column, so picking
 * one would be an arbitrary, not-necessarily-stable choice dressed up as a default. No route or
 * CLI verb writes a second row today (nothing writes this table at all outside tests), so this
 * branch is unreached in practice -- but a function this dispatch-critical says what it does
 * rather than leaning on that.
 */
export async function workspaceDefaultProvider(
  workspaceId: string,
  // H4a: the Supervisor's world loader asks this INSIDE its own `RepeatableRead` snapshot -- the
  // whole contract of that load is "the world one decision was made on", and a read taken on the
  // global client would be a second instant mixed into it. `staleCandidateCount`'s own shape;
  // every existing caller passes nothing and reads exactly as it always did.
  tx: Pick<typeof prisma, 'providerConfiguration'> = prisma,
): Promise<ProviderKind | null> {
  const rows = await tx.providerConfiguration.findMany({ where: { workspaceId }, select: { kind: true } })
  // The length check just above is what guarantees index 0 exists; `noUncheckedIndexedAccess`
  // cannot see that relationship, hence the assertion rather than a redundant re-check.
  return rows.length === 1 ? rows[0]!.kind : null
}
