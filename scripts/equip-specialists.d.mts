// The types `scripts/equip-specialists.mjs` is imported with (`allowJs` is off everywhere; see
// `backfill-evidence.d.mts`). Only the pure planner is exported; the rest is the script's body.

export interface BundleConfig {
  readonly bundles: Readonly<Record<string, readonly string[]>>
  readonly divisions: Readonly<Record<string, readonly string[]>>
  readonly personas: Readonly<Record<string, readonly string[]>>
}

export interface PlannedTemplate {
  readonly name: string
  readonly sourceDivision: string | null
}

export function planBundles<T extends PlannedTemplate>(
  config: BundleConfig,
  templates: readonly T[],
): {
  readonly plan: readonly { readonly template: T; readonly bundles: readonly string[]; readonly refs: readonly string[] }[]
  readonly problems: readonly string[]
}
