import type { OverrideLevels, OverrideOrigin, Resolved } from './types.js'

/**
 * The override chain, once, for all three things that have one (R7).
 *
 * M37 wrote `effectiveProfile` for `slave -> companySlave -> template`, and `resolveRuntime`
 * (`packages/control/src/runtime.ts`) walked the same three levels for model and provider with its
 * own copy of the ladder. M58 replaces the middle level -- the roster row -- with the PERSON, and
 * takes the opportunity to make it one function: a fourth thing with an override chain adds a
 * wrapper here and no new ladder anywhere.
 *
 * PURE, and in `packages/domain` rather than beside either caller, because it has three callers in
 * three packages: `buildRunContext` at dispatch, `packages/control`'s runtime resolution, and the
 * web's person panel -- and the web may not import an application.
 */
export function resolveOverride<T>(levels: OverrideLevels<T>): Resolved<T> | null {
  if (levels.seat !== null) return { value: levels.seat, origin: 'seat' }
  if (levels.person !== null) return { value: levels.person, origin: 'person' }
  if (levels.template !== null) return { value: levels.template, origin: 'template' }
  return null
}

/**
 * The persona that actually applies, and which level it came from.
 *
 * The EMPTY-STRING rule is M37's and survives verbatim: an empty string at a level is that level
 * saying "cleared", so it wins its own position in the chain and then renders nothing. That is what
 * `set-profile --clear` writes, and it is why this is not just `resolveOverride`.
 *
 * `PROFILE_MAX_CHARS` is NOT checked here: this function is pure and the cap has two enforcement
 * points that both want to say something different about it (a refusal at write, a refused dispatch
 * at read). See `packages/domain/src/run-context/profile.ts`.
 */
export function effectiveProfileFor(
  levels: OverrideLevels<string>,
): { readonly text: string; readonly origin: OverrideOrigin } | null {
  const resolved = resolveOverride(levels)
  if (resolved === null || resolved.value === '') return null
  return { text: resolved.value, origin: resolved.origin }
}

/** The model, through the same three levels. No empty-string rule: `model` and `provider` move as a
 *  PAIR and are cleared by writing `null` to both (`setSlaveModel`'s own contract), so an empty
 *  string here is a value somebody typed and this function reports it rather than hiding it. */
export function effectiveModelFor(levels: OverrideLevels<string>): Resolved<string> | null {
  return resolveOverride(levels)
}

/** The provider, through the same three levels. Generic over the kind's string union so the domain
 *  need not import `packages/providers` -- the caller keeps its own `ProviderKind`. */
export function effectiveProviderFor<K extends string>(levels: OverrideLevels<K>): Resolved<K> | null {
  return resolveOverride(levels)
}
