import { z } from 'zod'
import { SKELETON_PACKAGE_KEY } from './constants.js'
import { globToRegExp, isValidOwnedGlob } from './glob.js'

/**
 * Skeleton spec S1–S3: the rules that make a partitioned plan buildable. A skeleton package runs
 * first and owns what every other package builds on; shared registration points are
 * file-per-package; a dependency manifest and its lockfile have one owner. Pure: `validateConduct`
 * calls these and lists every refusal in its one sentence list (Conductor Plan 2 D4).
 */

/** The project's gate runner (S4): it runs every `scripts/verify.d/*.sh` in name order. */
export const VERIFY_SCRIPT_PATH = 'scripts/verify.sh'
/** The smoke check (S5). The orchestrator runs it before verification (Plan B). */
export const SMOKE_SCRIPT_PATH = 'scripts/smoke.sh'
export const VERIFY_CHECKS_DIR = 'scripts/verify.d'

/** S3: the one check file a package owns, so no two packages ever edit the same gate file (OBS-10, OBS-22). */
export function verifyCheckPathFor(packageKey: string): string {
  return `${VERIFY_CHECKS_DIR}/${packageKey}.sh`
}

/** S2, verbatim: a manifest and the lockfiles that are written with it, in the same directory. */
export const MANIFEST_LOCK_PAIRS: readonly { readonly manifest: string; readonly locks: readonly string[] }[] = [
  { manifest: 'package.json', locks: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'] },
  { manifest: 'pyproject.toml', locks: ['uv.lock', 'poetry.lock', 'pdm.lock'] },
  { manifest: 'Pipfile', locks: ['Pipfile.lock'] },
  { manifest: 'Cargo.toml', locks: ['Cargo.lock'] },
  { manifest: 'go.mod', locks: ['go.sum'] },
  { manifest: 'Gemfile', locks: ['Gemfile.lock'] },
  { manifest: 'composer.json', locks: ['composer.lock'] },
]

/** Plan A D3: the build/start/deploy files a FALLBACK skeleton takes at the root when nobody claims them. */
export const SKELETON_ROOT_BUILD_FILES: readonly string[] = [
  'Dockerfile', '.dockerignore', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Makefile',
]

/** What a validator-made skeleton's contract says it provides. */
export const SKELETON_INTERFACE =
  'A runnable empty product every other package builds on: the entry point and server bootstrap, every dependency manifest with its lockfile, ' +
  'the build and start files, scripts/smoke.sh, and the loaders of the shared registration directories.'

/** S3/plan A D5: an ordered shared directory a package adds files to, only under its own prefix. */
export interface PackageRegistration {
  readonly directory: string
  readonly prefix: string
}

/** One registration's shape. Its content rules are {@link isValidRegistration}'s, so the conductor's
 *  answer, a stored plan and a stored row all read through this one schema. */
export const registrationSchema = z.object({ directory: z.string(), prefix: z.string() })

/** A stored `WorkPackage.registrations` or plan field, read defensively: a missing field, or a row
 *  a later build wrote differently, reads as none. */
export const registrationsSchema = z.array(registrationSchema).catch([])

/** Longest registration directory and prefix: a path, and a file-name stem, not a paragraph. */
export const REGISTRATION_DIRECTORY_MAX_CHARS = 200
export const REGISTRATION_PREFIX_MAX_CHARS = 40

/** A directory as written by a person or a model, without its trailing slashes. */
export function trimSlash(directory: string): string {
  return directory.replace(/\/+$/u, '')
}

export function registrationGlob(registration: PackageRegistration): string {
  return `${trimSlash(registration.directory)}/${registration.prefix}*`
}

/** A plain repository-relative directory (no glob operator) and a prefix with no `/`, `*` or `?`. */
export function isValidRegistration(registration: PackageRegistration): boolean {
  const directory = trimSlash(registration.directory)
  return (
    directory !== '' &&
    directory.length <= REGISTRATION_DIRECTORY_MAX_CHARS &&
    isValidOwnedGlob(directory) &&
    !/[*?]/u.test(directory) &&
    registration.prefix !== '' &&
    registration.prefix.length <= REGISTRATION_PREFIX_MAX_CHARS &&
    !/[/*?]/u.test(registration.prefix)
  )
}

/** A glob with no operator: a file named outright. The disjointness check tests these as paths too. */
export function isLiteralPath(glob: string): boolean {
  return !/[*?]/u.test(glob) && !glob.endsWith('/')
}

/** The manifest-and-lockfile family `path` belongs to, in its directory; `[]` for any other path. */
export function manifestFamily(path: string): readonly string[] {
  const slash = path.lastIndexOf('/')
  const directory = slash === -1 ? '' : path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const pair = MANIFEST_LOCK_PAIRS.find((entry) => entry.manifest === name || entry.locks.includes(name))
  return pair === undefined ? [] : [pair.manifest, ...pair.locks].map((member) => `${directory}${member}`)
}

interface Owned {
  readonly key: string
  readonly ownedPaths: readonly string[]
}

const owns = (pkg: Owned, path: string): boolean => pkg.ownedPaths.some((glob) => globToRegExp(glob).test(path))

/** What exists or was declared, plus every file a package named outright (ruling F4): a manifest
 *  and its lockfile given as literals to two packages split the family before either file exists. */
const withLiterals = (packages: readonly Owned[], known: readonly string[]): readonly string[] =>
  [...new Set([...known, ...packages.flatMap((pkg) => pkg.ownedPaths.filter(isLiteralPath))])]

/**
 * S1/S2, plan A D4: for every manifest or lockfile that exists, is declared or is owned by name, its whole family
 * belongs to the skeleton. A package that is not the skeleton and owns any member, by any glob
 * (a lockfile that does not exist yet included), is refused with the family named: splitting them
 * makes every dependency change a guaranteed ownership violation (OBS-7).
 */
export function manifestProblems(packages: readonly Owned[], known: readonly string[]): readonly string[] {
  const problems = new Set<string>()
  for (const path of withLiterals(packages, known)) {
    const family = manifestFamily(path)
    for (const member of family) {
      for (const holder of packages) {
        if (holder.key === SKELETON_PACKAGE_KEY || !owns(holder, member)) continue
        problems.add(`package "${holder.key}" owns ${member}, but ${family.join(', ')} change together and belong to the ${SKELETON_PACKAGE_KEY} package`)
      }
    }
  }
  return [...problems].slice(0, 10)
}

/**
 * S1, plan A D3: the paths added to the skeleton's own -- the two gate scripts, every family of a
 * known or literally owned manifest or lockfile, and (fallback only) the root build files -- each only when no other
 * package's glob claims it. A gate script another package claims is refused here. A claimed
 * manifest is `manifestProblems`'s refusal.
 */
export function skeletonPaths(
  packages: readonly Owned[],
  known: readonly string[],
  fallback: boolean,
): { readonly add: readonly string[]; readonly problems: readonly string[] } {
  const skeleton = packages.find((pkg) => pkg.key === SKELETON_PACKAGE_KEY)
  const others = packages.filter((pkg) => pkg.key !== SKELETON_PACKAGE_KEY)
  const problems: string[] = []
  for (const script of [VERIFY_SCRIPT_PATH, SMOKE_SCRIPT_PATH]) {
    const holder = others.find((pkg) => owns(pkg, script))
    if (holder !== undefined) problems.push(`package "${holder.key}" owns ${script}, which belongs to the ${SKELETON_PACKAGE_KEY} package`)
  }
  const wanted = [VERIFY_SCRIPT_PATH, SMOKE_SCRIPT_PATH, ...withLiterals(packages, known).flatMap(manifestFamily), ...(fallback ? SKELETON_ROOT_BUILD_FILES : [])]
  const add = [...new Set(wanted)].filter((path) => !(skeleton !== undefined && owns(skeleton, path)) && !others.some((pkg) => owns(pkg, path)))
  return { add, problems }
}

/** A file name under a registration's prefix that no real file will have: what "another package owns this directory" is tested against. */
const REGISTRATION_PROBE = 'registration-probe'

/**
 * S3, plan A D5: a package that owns files in a directory another package registers into is
 * refused -- a whole shared directory given to one package (OBS-11), or two prefixes where one is a
 * prefix of the other. Tested with a probe path under the registering package's prefix.
 */
export function registrationProblems(
  packages: readonly (Owned & { readonly registrations: readonly PackageRegistration[] })[],
): readonly string[] {
  const problems: string[] = []
  for (const pkg of packages) {
    for (const registration of pkg.registrations) {
      const probe = `${trimSlash(registration.directory)}/${registration.prefix}${REGISTRATION_PROBE}`
      for (const other of packages) {
        if (other.key === pkg.key || !owns(other, probe)) continue
        problems.push(
          `package "${other.key}" owns files in ${trimSlash(registration.directory)} that package "${pkg.key}" registers there ` +
            `(${registrationGlob(registration)}): a shared directory is file-per-package -- give each package only the files ` +
            `that start with its own prefix, and the ${SKELETON_PACKAGE_KEY} only the loader`,
        )
      }
    }
  }
  return problems.slice(0, 10)
}
