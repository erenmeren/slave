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

/** Whether a project's verification gate runs `scripts/verify.sh` -- the only way a
 *  `scripts/verify.d/` check reaches the gate (final review I1). A draft may name its own gate
 *  (`npm test`) though the runner is planted beside it. */
export function gateRunsVerifyScript(verifyCommands: readonly string[]): boolean {
  const named = new RegExp(`(?:^|[\\s/'"(;&|])${VERIFY_SCRIPT_PATH.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w.-])`, 'u')
  return verifyCommands.some((command) => named.test(command))
}

/** What a new repository's first commit holds, and repository furniture: none of it is a product.
 *  Root-level names, plus the gate scripts and their check directory. */
const NOT_PRODUCT_FILE = /^(?:README(?:\.[^/]*)?|LICEN[CS]E(?:\.[^/]*)?|\.git[^/]*|\.editorconfig|scripts\/verify\.sh|scripts\/smoke\.sh|scripts\/verify\.d\/[^/]*)$/u

/**
 * Final review I3: whether a repository's tracked files already hold a product -- anything beyond
 * a new repository's first commit (README, the two gate scripts) and repository furniture. A
 * skeleton on such a base keeps the product runnable rather than building an empty one over it
 * (goal v2, or a project created over an existing repository).
 */
export function hasProductFiles(trackedFiles: readonly string[]): boolean {
  return trackedFiles.some((path) => path !== '' && !NOT_PRODUCT_FILE.test(path))
}

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

/**
 * A plain repository-relative directory, written as git writes paths (no glob operator, no `./`,
 * no empty or `.` segment -- such a directory never matches a real path, so its prefix glob and the
 * overlap check would both miss), and a prefix with no `/`, `*` or `?`.
 */
export function isValidRegistration(registration: PackageRegistration): boolean {
  const directory = trimSlash(registration.directory)
  return (
    directory !== '' &&
    directory.split('/').every((segment) => segment !== '' && segment !== '.') &&
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

/**
 * Directories whose manifests are not the product's own: installed or vendored dependencies, and
 * test fixtures and test data (final review ruling). A `test/fixtures/x/package.json` reserved for
 * the skeleton would refuse every plan giving `test/**` to a tests package, and burn the conduct
 * retries of a legacy repository on it.
 */
export const NON_PRODUCT_MANIFEST_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'vendor', 'fixtures', '__fixtures__', 'testdata'])

/** The manifest-and-lockfile family `path` belongs to, in its directory; `[]` for any other path,
 *  and for one under a {@link NON_PRODUCT_MANIFEST_DIRECTORIES} segment. */
export function manifestFamily(path: string): readonly string[] {
  const slash = path.lastIndexOf('/')
  if (path.slice(0, Math.max(slash, 0)).split('/').some((segment) => NON_PRODUCT_MANIFEST_DIRECTORIES.has(segment))) return []
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

/** The part of a glob before its first operator: every path it can match starts with this. */
const literalPrefix = (glob: string): string => glob.slice(0, glob.search(/[*?]/u) === -1 ? glob.length : glob.search(/[*?]/u))

/**
 * Whether `glob` can own a file under `<directory>/<prefix>`, judged by prefixes alone (review
 * fix I2): an extension-limited glob such as `db/m/*.sql` passes the extensionless probe, yet owns
 * `db/m/02_b_x.sql`. A named file is refused when it lies under the prefix; a glob with an operator
 * (or a trailing `/`) when its literal prefix and `<directory>/<prefix>` are prefixes of one
 * another -- which also refuses a few globs that only share a directory prefix, on purpose.
 */
const mayOwnUnder = (glob: string, registered: string): boolean => {
  if (isLiteralPath(glob)) return glob.startsWith(registered)
  const head = literalPrefix(glob)
  return head.startsWith(registered) || registered.startsWith(head)
}

/**
 * S3, plan A D5: a package that owns files in a directory another package registers into is
 * refused -- a whole shared directory given to one package (OBS-11), or two prefixes where one is a
 * prefix of the other. Tested with a probe path under the registering package's prefix, and by
 * {@link mayOwnUnder} for globs the probe cannot see.
 */
export function registrationProblems(
  packages: readonly (Owned & { readonly registrations: readonly PackageRegistration[] })[],
): readonly string[] {
  const problems: string[] = []
  // One refusal per pair: nested prefixes (`01_`, `01_b_`) overlap in both directions.
  const refusedPairs = new Set<string>()
  for (const pkg of packages) {
    for (const registration of pkg.registrations) {
      const probe = `${trimSlash(registration.directory)}/${registration.prefix}${REGISTRATION_PROBE}`
      for (const other of packages) {
        const registered = `${trimSlash(registration.directory)}/${registration.prefix}`
        if (other.key === pkg.key || !(owns(other, probe) || other.ownedPaths.some((glob) => mayOwnUnder(glob, registered)))) continue
        const pair = [other.key, pkg.key].sort().join('\n')
        if (refusedPairs.has(pair)) continue
        refusedPairs.add(pair)
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
