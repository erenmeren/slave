import { refusalText } from '@slave-of-ai/control'
import {
  UnknownProviderError,
  type AdapterRegistry,
  type SlaveRuntimeAdapter,
  type ProviderKind,
} from '@slave-of-ai/providers'

/**
 * The single place every `deps.adapter.x(...)` call site in the orchestrator resolves a live
 * `SlaveRuntimeAdapter` out of an `AdapterRegistry`.
 *
 * M12 Task 5 through 7 left this function resolving a hardcoded `'claude_code'` constant that
 * lived in `packages/control/src/pause.ts` (`CURRENT_PROVIDER_KIND`, deleted at Task 8's fix
 * round -- do not go looking for it), regardless of what any caller actually wanted. `kind` is now the caller's own resolved
 * value: `resolveRuntime`'s output for a fresh dispatch (`tick.ts`, `planning.ts`, `review.ts`), or
 * a checkpoint's/run's own recorded provider for a continuation (`resume.ts`, `sweep.ts`) -- never
 * a constant, because there is no longer one runtime every RUN goes through.
 *
 * `UnknownProviderError` -- a `ProviderKind` this process has no adapter for, `'cursor'` until
 * Task 12 -- is translated into the milestone's own `invalid_provider` wording (spec-verbatim,
 * `packages/control`'s `refusal.ts`) rather than left as the registry's own message. Task 7's
 * ledger named the gap this closes: `packages/control/src/org.ts`'s `isProviderKind` can only
 * check that a string is a MEMBER of the `ProviderKind` union (it has no registry to check against
 * -- the registry is an orchestrator-process concept, built per deployment from whichever adapters
 * that process was given, not something a pure Prisma-backed control function can see), so writing
 * `provider: 'cursor'` today succeeds and mints a row nothing can actually run. This function is
 * the first place that CAN tell "known kind" from "configured kind" apart, because it is the first
 * place holding both the value and the registry -- so refusing here, with the same text the write
 * path already promises, is where the check finally meets it.
 */
export function resolveAdapter(registry: AdapterRegistry, kind: ProviderKind): SlaveRuntimeAdapter {
  try {
    return registry.resolve(kind)
  } catch (error) {
    if (error instanceof UnknownProviderError) {
      throw new Error(refusalText({ kind: 'invalid_provider', provider: kind }))
    }
    throw error
  }
}
