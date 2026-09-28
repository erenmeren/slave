import { globToRegExp } from './glob.js'
import type { PackageSpec } from './packages.js'

type Owner = Pick<PackageSpec, 'key' | 'ownedPaths' | 'isIntegration'>

/** What a denial for a file another package owns is called (spec R4). Not a `PermissionKind`:
 *  no grant can open it, so it must never become a `request_permission` proposal. */
export const FOREIGN_FILE_DENIAL = 'foreign_file'

/**
 * Which repo-relative paths one package may change (spec R4), in globs. `owned: null` is "every
 * path" -- the integration package's shape, whose `excluded` is every other package's globs,
 * exactly `ownerOf`'s fallback. The two enforcers (the gate and the diff audit) read this one rule.
 */
export interface OwnershipRule {
  readonly owned: readonly string[] | null
  readonly excluded: readonly string[]
}

/** The rule for `pkg` among its goal version's packages; `null` when it owns `**` (spec R4:
 *  "`single` mode owns `**`, so both checks pass trivially"). */
export function ownershipRuleFor(pkg: Owner, all: readonly Owner[]): OwnershipRule | null {
  if (pkg.ownedPaths.includes('**')) return null
  if (pkg.isIntegration) {
    return { owned: null, excluded: all.filter((p) => !p.isIntegration && p.key !== pkg.key).flatMap((p) => p.ownedPaths) }
  }
  return { owned: [...pkg.ownedPaths], excluded: [] }
}

export function isOwned(rule: OwnershipRule, path: string): boolean {
  const inOwned = rule.owned === null || rule.owned.some((glob) => globToRegExp(glob).test(path))
  return inOwned && !rule.excluded.some((glob) => globToRegExp(glob).test(path))
}

export interface OwnershipPatterns {
  readonly owned: readonly string[] | null
  readonly excluded: readonly string[]
}

/** The rule as regex SOURCES for the gate's node script (plan decision D1): one glob
 *  implementation, rebuilt there with `new RegExp(source, 'u')`. */
export function ownershipPatterns(rule: OwnershipRule): OwnershipPatterns {
  const sources = (globs: readonly string[]): readonly string[] => globs.map((glob) => globToRegExp(glob).source)
  return { owned: rule.owned === null ? null : sources(rule.owned), excluded: sources(rule.excluded) }
}
