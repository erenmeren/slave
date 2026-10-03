import { err, ok, type Result } from '../result.js'
import { SKELETON_PACKAGE_KEY } from './constants.js'
import { isOwned, ownershipRuleFor } from './ownership.js'
import { manifestProblems, registrationProblems, type PackageRegistration } from './skeleton.js'
import { handOffPath } from './smoke.js'

/** What {@link planFileGrant} reads of one `WorkPackage`. */
export interface GrantPackage {
  readonly key: string
  readonly ownedPaths: readonly string[]
  readonly releasedPaths: readonly string[]
  readonly isIntegration: boolean
  readonly registrations: readonly PackageRegistration[]
}

/** A grant as it will be written: each package whose arrays change, and what to. */
export interface FileGrant {
  readonly path: string
  readonly fromKey: string | null
  readonly toKey: string
  readonly changes: readonly { readonly key: string; readonly ownedPaths: readonly string[]; readonly releasedPaths: readonly string[] }[]
}

const owners = (path: string, packages: readonly GrantPackage[]): readonly GrantPackage[] =>
  packages.filter((pkg) => {
    const rule = ownershipRuleFor(pkg, packages)
    return rule !== null && isOwned(rule, path)
  })

/**
 * Human-cards spec H2.4 (plan B D5): moves one concrete file from the package that owns it to
 * `toKey`, or says why not. The only ownership change in the system, so it is judged by the rules
 * the conductor's plan was validated with: one non-integration owner per file, a manifest family
 * only with the skeleton, a shared registration directory file-per-package. The owner releases a
 * glob-owned file (`releasedPaths`) or loses a named one; the target owns it by name. Pure: the
 * caller writes `changes` under the delivery lock.
 */
export function planFileGrant(input: { readonly path: string; readonly toKey: string; readonly packages: readonly GrantPackage[] }): Result<FileGrant, string> {
  const { packages, toKey } = input
  const path = handOffPath(input.path)
  if (path === null) return err(`"${input.path}" is not one repository file: give a path with no glob, "..", "./" or leading "/"`)
  const target = packages.find((pkg) => pkg.key === toKey)
  if (target === undefined) return err(`no package has the key "${toKey}"`)
  if (packages.some((pkg) => pkg.ownedPaths.includes('**'))) return err('one package owns every file in this goal version: there is nothing to give')

  const before = owners(path, packages)
  const from = before.find((pkg) => !pkg.isIntegration) ?? before[0] ?? null
  if (from?.key === toKey) return err(`the ${toKey} package already owns ${path}`)

  const changes = new Map<string, { ownedPaths: string[]; releasedPaths: string[] }>()
  const edit = (pkg: GrantPackage): { ownedPaths: string[]; releasedPaths: string[] } => {
    const seen = changes.get(pkg.key) ?? { ownedPaths: [...pkg.ownedPaths], releasedPaths: [...pkg.releasedPaths] }
    changes.set(pkg.key, seen)
    return seen
  }
  let released = false
  if (from !== null && !from.isIntegration) {
    // A name is taken away; a glob that still matches is narrowed by releasing the path from it.
    const owned = edit(from)
    owned.ownedPaths = owned.ownedPaths.filter((glob) => glob !== path)
    const stillOwns = ownershipRuleFor({ ...from, ...owned }, [{ ...from, ...owned }])
    if (stillOwns !== null && isOwned(stillOwns, path) && !owned.releasedPaths.includes(path)) {
      owned.releasedPaths.push(path)
      released = true
    }
  }
  if (target.isIntegration) {
    // The integration package owns only what nobody else owns: its rule excludes every other
    // package's globs, so a file one of them still covers by a glob -- held only by it, or by name
    // and by that glob -- cannot reach it without the hook plane (plan B D5); nobody would own it.
    if (from !== null && released) {
      return err(`the integration package owns only files no other package owns, and ${path} is in the ${from.key} package's ${from.ownedPaths.join(', ')}: give the ${from.key} package the work instead`)
    }
  } else {
    const gaining = edit(target)
    if (!gaining.ownedPaths.includes(path)) gaining.ownedPaths.push(path)
    gaining.releasedPaths = gaining.releasedPaths.filter((kept) => kept !== path)
  }

  const after = packages.map((pkg) => ({ ...pkg, ...(changes.get(pkg.key) ?? {}) }))
  const owning = owners(path, after)
  // The integration package can be refused a file another package released from a glob earlier:
  // that glob still excludes it from the integration rule, so nobody would own it.
  if (!owning.some((pkg) => pkg.key === toKey)) {
    return err(`the ${toKey} package would not own ${path} after the grant: the integration package owns only files no other package's globs cover`)
  }
  const nonIntegration = owning.filter((pkg) => !pkg.isIntegration).map((pkg) => pkg.key)
  const expected = target.isIntegration ? [] : [toKey]
  if (nonIntegration.join('\n') !== expected.join('\n')) {
    return err(`two packages would own ${path} (${nonIntegration.join(', ')}): a file has one owner`)
  }
  const family = manifestProblems([{ key: toKey, ownedPaths: [path] }], [path])
  if (toKey !== SKELETON_PACKAGE_KEY && family.length > 0) return err(family.join('; '))
  const known = new Set(registrationProblems(packages))
  const added = registrationProblems(after).filter((problem) => !known.has(problem))
  if (added.length > 0) return err(added.join('; '))

  return ok({
    path,
    fromKey: from?.key ?? null,
    toKey,
    changes: [...changes.entries()].map(([key, arrays]) => ({ key, ownedPaths: arrays.ownedPaths, releasedPaths: arrays.releasedPaths })).sort((a, b) => a.key.localeCompare(b.key)),
  })
}
