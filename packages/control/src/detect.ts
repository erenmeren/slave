import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, normalize } from 'node:path'
import type { PathFact, VerifyFinding } from '@slave-of-ai/domain'
import { realGitProbe, type GitProbe } from './git-probe.js'

/**
 * Deterministic detection (M59 R6, decision D6).
 *
 * NOTHING HERE IS EXECUTED. A `package.json` script named `test` produces the STRING `npm test`
 * and is never run; a `Makefile` is read as text and `make` is never spawned. The only child
 * process this module can cause is `git`, through {@link GitProbe}, which reads refs. That is what
 * makes it safe to point at a path a person typed into a chat box -- and it is the whole of why
 * the model is never asked to invent a command: code reads the repository, the model picks from
 * what was read.
 */

/** The most paths one message may cause a probe of. Four: a person naming five repositories in one
 *  sentence is not describing one project, and every path costs a `stat`, a `readdir` and two
 *  `git` invocations. */
export const DETECT_MAX_PATHS = 4

/**
 * An absolute path or a `~/...` one, anywhere in a sentence.
 *
 * The boundary characters matter more than the path alphabet does: a person writes `the repo is at
 * /home/me/api,` and `use "/home/me/api" for this`, so a trailing comma, quote, bracket or
 * semicolon ends the match while a dash or a dot does not. A bare `/` with nothing after it is not
 * a path anybody means, and the `+` after the first character is what excludes it.
 */
const PATH_RE = /(?:^|[\s"'`(<[])((?:~|\/)[^\s"'`)>\],;]+)/gu

/**
 * Every path in `text`, plus `extra` (the draft's own `repoPath`, so a second message about a
 * repository the first one named re-measures it), de-duplicated in first-seen order and capped.
 *
 * `~` is expanded here rather than left to a later reader: every consumer of this list treats its
 * members as absolute, and a `~` that survived would reach `stat` as a relative path named `~`.
 */
export function findPaths(text: string, extra: readonly string[] = []): readonly string[] {
  const found: string[] = []
  const push = (raw: string): void => {
    const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
    const path = normalize(expanded).replace(/\/+$/u, '')
    if (path !== '' && path !== '/' && !found.includes(path)) found.push(path)
  }
  for (const match of text.matchAll(PATH_RE)) {
    const raw = match[1]
    if (raw !== undefined) push(raw)
  }
  for (const path of extra) push(path)
  return found.slice(0, DETECT_MAX_PATHS)
}

/** The npm scripts R6 names, in R6's order -- so `npm test` precedes `npm run build` in every
 *  fact row and in every draft built from one. */
const NPM_SCRIPTS = ['test', 'typecheck', 'lint', 'build'] as const

/** Which runner a lockfile names. First match wins, in this order, and `npm` is the answer when a
 *  `package.json` carries no lockfile beside it at all. */
const LOCKFILES: readonly (readonly [string, string])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
]

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null
}

async function runnerFor(path: string): Promise<string> {
  for (const [lockfile, runner] of LOCKFILES) {
    if (await exists(join(path, lockfile))) return runner
  }
  return 'npm'
}

/** `npm test` for the test script and `npm run <name>` for the others -- the shorthand every
 *  runner honours for that one script, and the form a person recognises. */
function scriptCommand(runner: string, script: string): string {
  return script === 'test' ? `${runner} test` : `${runner} run ${script}`
}

async function nodeFindings(path: string): Promise<VerifyFinding[]> {
  const source = await readFile(join(path, 'package.json'), 'utf8').catch(() => null)
  if (source === null) return []
  let scripts: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(source)
    // A `package.json` that is not an object, or whose `scripts` is not one, is not a finding and
    // is not an error either: detection reports what it could read and stays quiet about the rest.
    if (parsed !== null && typeof parsed === 'object') {
      const value = (parsed as { scripts?: unknown }).scripts
      if (value !== null && typeof value === 'object') scripts = value as Record<string, unknown>
    }
  } catch {
    return []
  }
  const runner = await runnerFor(path)
  return NPM_SCRIPTS.filter((script) => typeof scripts[script] === 'string').map((script) => ({
    command: scriptCommand(runner, script),
    source: `package.json scripts.${script}`,
  }))
}

/** A `test:` or `check:` target at the start of a line. Deliberately not a Make parser: a target
 *  is a line that begins with the name and a colon, and anything cleverer would be a second
 *  implementation of Make in a file that must never run one. */
async function makeFindings(path: string): Promise<VerifyFinding[]> {
  const source = await readFile(join(path, 'Makefile'), 'utf8').catch(() => null)
  if (source === null) return []
  return (['test', 'check'] as const)
    .filter((target) => new RegExp(`^${target}\\s*:`, 'mu').test(source))
    .map((target) => ({ command: `make ${target}`, source: `Makefile target ${target}` }))
}

/**
 * Every verify command this path really offers, in R6's order (M59 R6).
 *
 * Never throws and never executes. A directory that does not exist, one this process cannot read,
 * and one with nothing recognisable in it all answer the same way: an empty list, which the
 * conversation renders as "found no verify command" and the model must then ASK about.
 */
export async function detectVerify(path: string): Promise<readonly VerifyFinding[]> {
  const findings: VerifyFinding[] = [...(await nodeFindings(path)), ...(await makeFindings(path))]
  if ((await exists(join(path, 'pyproject.toml'))) || (await exists(join(path, 'pytest.ini')))) {
    findings.push({ command: 'pytest', source: (await exists(join(path, 'pyproject.toml'))) ? 'pyproject.toml' : 'pytest.ini' })
  }
  if (await exists(join(path, 'Cargo.toml'))) findings.push({ command: 'cargo test', source: 'Cargo.toml' })
  if (await exists(join(path, 'go.mod'))) findings.push({ command: 'go test ./...', source: 'go.mod' })
  return findings
}

/**
 * What one path IS (M59 R6): whether it is there, whether it is a git work tree, whether it is an
 * empty directory, which branches it has, which one `HEAD` points at, and what it can be verified
 * with.
 *
 * `probe` is a parameter with a default rather than the module-level singleton `createWorkspace`
 * keeps, because this is called in a loop over several paths and a test that wants to answer for
 * four of them differently should not have to install a global.
 */
export async function inspectPath(path: string, probe: GitProbe = realGitProbe): Promise<PathFact> {
  const info = await stat(path).catch(() => null)
  if (info === null || !info.isDirectory()) {
    return { path, exists: info !== null, isRepository: false, isEmptyDir: false, branches: [], defaultBranch: null, verify: [] }
  }
  const entries = await readdir(path).catch(() => [])
  const isRepository = await probe.isRepository(path)
  return {
    path,
    exists: true,
    isRepository,
    isEmptyDir: entries.length === 0,
    branches: isRepository ? [...(await probe.listBranches(path))] : [],
    defaultBranch: isRepository ? await probe.defaultBranch(path) : null,
    verify: [...(await detectVerify(path))],
  }
}
