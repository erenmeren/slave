/**
 * The skill catalog: what is on the daemon host's disk, and where each catalogued skill's files
 * live so a dispatch can copy them into a worktree (M14 §4.3, M37 §4).
 *
 * **Where the roots come from.** `skillRoots()` is the one answer, and it reads the environment
 * variable {@link SKILL_ROOTS_ENV} (`SLAVEOFAI_SKILL_ROOTS_JSON`, a JSON object with `personal`,
 * `pluginCache` and `project` paths) before falling back to the host's own `~/.claude` layout.
 * That seam exists for M37's gate, which drives a real daemon subprocess and can only reach it
 * through the environment; in-process callers pass roots as arguments instead.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { type Result, err, ok } from '@slave-of-ai/domain'
import type { ControlRefusal } from './refusal.js'

/** Where a skill was found. `roots` defaults to the three real ones (M14 §4.3); tests pass a
 *  temp tree. */
export interface SkillRoots {
  /** `~/.claude/skills` -- provider `personal`. */
  readonly personal: string
  /** `~/.claude/plugins/cache` -- provider `plugin:<plugin>`, highest version wins. */
  readonly pluginCache: string
  /** `<repo>/.claude/skills` -- provider `project`. */
  readonly project: string
}

/** Which of the three roots a `SkippedRoot` names. */
export type SkillRootName = 'personal' | 'pluginCache' | 'project'

/**
 * A root the scan could not READ -- as opposed to one that is simply not there.
 *
 * The two must never be confused (Decision 6, review fix round 1): an absent root means its skills
 * really are gone and should be stamped; an unreadable one means the scan learned nothing, and
 * stamping on that evidence would be the catalog lying about what disappeared. A skipped root is
 * neither marked nor cleared this pass -- the next scan, or `orchestrator skills sync`, decides.
 */
export interface SkippedRoot {
  readonly root: SkillRootName
  readonly path: string
  /** The errno that made it unreadable (`EACCES`, `EIO`, ...). Never `ENOENT`/`ENOTDIR`. */
  readonly code: string
}

export interface SyncResult {
  readonly providers: number
  readonly upserted: number
  /** Skills present in the DB but absent from disk this scan; each got `missingSince` set. */
  readonly markedMissing: number
  /** Roots that could not be read this pass; nothing under them was marked or cleared. */
  readonly skippedRoots: readonly SkippedRoot[]
}

/** The daemon host's own three roots (M14 §4.3). `project` is resolved from the process's cwd --
 *  the daemon runs from the repository, and a plan that hardcoded a path would be wrong on every
 *  other machine. */
function defaultRoots(): SkillRoots {
  return {
    personal: join(homedir(), '.claude', 'skills'),
    pluginCache: join(homedir(), '.claude', 'plugins', 'cache'),
    project: join(process.cwd(), '.claude', 'skills'),
  }
}

/**
 * The environment variable that redirects every skill root away from the operator's real
 * `~/.claude` (M37 Task 2, pre-flight ruling). A JSON object with all three keys:
 *
 * ```
 * SLAVEOFAI_SKILL_ROOTS_JSON='{"personal":"/tmp/x/personal","pluginCache":"/tmp/x/plugins","project":"/tmp/x/project"}'
 * ```
 *
 * It exists for the M37 gate, which drives a REAL daemon subprocess: a gate that read the host's
 * own skills would copy whatever the operator happens to have installed into a slave's worktree
 * and assert against it. In-process callers (tests, `buildRunContext`) pass roots directly instead.
 */
export const SKILL_ROOTS_ENV = 'SLAVEOFAI_SKILL_ROOTS_JSON'

/**
 * The three roots this process should read skills from: {@link SKILL_ROOTS_ENV} when it is set,
 * the host's own otherwise.
 *
 * A malformed value THROWS rather than falling back to the defaults. Falling back would silently
 * point a gate -- or a misconfigured daemon -- at the operator's real `~/.claude`, which is the one
 * outcome this seam exists to make impossible, and it would do it invisibly.
 */
export function skillRoots(): SkillRoots {
  const raw = process.env[SKILL_ROOTS_ENV]
  if (raw === undefined || raw === '') return defaultRoots()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${SKILL_ROOTS_ENV} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const field = (key: SkillRootName): string => {
    const value = (parsed as Record<string, unknown> | null)?.[key]
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${SKILL_ROOTS_ENV} must be an object with non-empty "personal", "pluginCache" and "project" paths`)
    }
    return value
  }
  return { personal: field('personal'), pluginCache: field('pluginCache'), project: field('project') }
}

interface Found {
  readonly provider: string
  readonly name: string
  readonly description: string
}

/** `---\nname: x\ndescription: y\n---` -- the two fields a SKILL.md must carry. Deliberately not a
 *  YAML parser: the frontmatter this reads is two scalar lines, and a dependency for that is a
 *  dependency for nothing. A file with no `name` is not a skill and is skipped. */
function parseFrontmatter(text: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return null
  const body = match[1] ?? ''
  const field = (key: string): string | null => {
    const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(body)
    return line === null ? null : (line[1] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  const name = field('name')
  if (name === null || name === '') return null
  return { name, description: field('description') ?? '' }
}

/** The errnos that mean "there is nothing here", as opposed to "I could not look". */
const ABSENT = new Set(['ENOENT', 'ENOTDIR'])

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

/** Either what a directory holds, or the errno that stopped us reading it. */
type DirRead = { readonly ok: true; readonly dirs: readonly string[] } | { readonly ok: false; readonly code: string }

function readDirs(dir: string): DirRead {
  try {
    return {
      ok: true,
      dirs: readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    }
  } catch (error) {
    const code = errnoOf(error)
    // A root that is simply not there is an ordinary machine, and its skills ARE gone. Anything
    // else -- EACCES, EIO, a half-mounted volume -- is a failure to look, and must not be read as
    // an empty directory.
    if (ABSENT.has(code)) return { ok: true, dirs: [] }
    return { ok: false, code }
  }
}

/** `statSync` rather than `existsSync`, which answers `false` for a directory it merely cannot
 *  stat -- the exact conflation this fix exists to remove. */
function isDir(path: string): { readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly code: string } {
  try {
    const stat = statSync(path, { throwIfNoEntry: false })
    return { ok: true, value: stat !== undefined && stat.isDirectory() }
  } catch (error) {
    const code = errnoOf(error)
    if (ABSENT.has(code)) return { ok: true, value: false }
    return { ok: false, code }
  }
}

/** What one root yielded: its skills, or the errno that made the whole root unusable this pass. */
interface Scan {
  readonly found: readonly Found[]
  readonly unreadable: string | null
}

/** Every `<dir>/<skill>/SKILL.md` under one skills directory, as `Found` rows for `provider`. */
function scanSkillsDir(dir: string, provider: string): Scan {
  const read = readDirs(dir)
  if (!read.ok) return { found: [], unreadable: read.code }

  const found: Found[] = []
  for (const name of read.dirs) {
    let text: string
    try {
      text = readFileSync(join(dir, name, 'SKILL.md'), 'utf8')
    } catch (error) {
      const code = errnoOf(error)
      // No SKILL.md, or a directory where one should be: not a skill, and not a failure.
      if (ABSENT.has(code) || code === 'EISDIR') continue
      return { found: [], unreadable: code }
    }
    // A file with no parseable `name` is not a skill -- that is a fact about the file, not a
    // failure to read the root, so the scan keeps going and the skill is simply not found.
    const parsed = parseFrontmatter(text)
    if (parsed === null) continue
    found.push({ provider, name: parsed.name, description: parsed.description })
  }
  return { found, unreadable: null }
}

/** `10.0.1` beats `9.9.9`. Compared segment by segment as NUMBERS -- a lexicographic sort puts
 *  `9.9.9` above `10.0.1`, which would pin a plugin to a stale version forever. A segment that is
 *  not a number sorts below every one that is (`unknown`, and the commit shas the plugin CLI
 *  writes for a marketplace with no version, are both of that shape). */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : -1))
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? -1) - (right[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * `<cache>/<marketplace>/<plugin>/<version>/skills` for every plugin in the cache, keeping the
 * highest version of each.
 *
 * Extracted from `scanPluginCache` (M37 Task 2) so `highestPluginVersionDir` -- which the run
 * builder uses to find ONE plugin's skills directory when it injects a skill into a worktree --
 * resolves a version through exactly the code that catalogued it. Two walks of the same tree would
 * be two answers to "which version of this plugin is live", and the prompt would then name a skill
 * from a directory nothing copied.
 */
function bestPluginVersionDirs(cacheDir: string): { readonly dirs: ReadonlyMap<string, string>; readonly unreadable: string | null } {
  const marketplaces = readDirs(cacheDir)
  if (!marketplaces.ok) return { dirs: new Map(), unreadable: marketplaces.code }

  const bestVersion = new Map<string, { version: string; dir: string }>()
  for (const marketplace of marketplaces.dirs) {
    const plugins = readDirs(join(cacheDir, marketplace))
    if (!plugins.ok) return { dirs: new Map(), unreadable: plugins.code }
    for (const plugin of plugins.dirs) {
      const versions = readDirs(join(cacheDir, marketplace, plugin))
      if (!versions.ok) return { dirs: new Map(), unreadable: versions.code }
      for (const version of versions.dirs) {
        const skillsDir = join(cacheDir, marketplace, plugin, version, 'skills')
        // Any unreadable level fails the WHOLE cache root, not just the plugin under it: a version
        // we could not see is a version whose skills we cannot vouch for, and half a cache is
        // exactly the evidence that produces a false mass-deletion.
        const skills = isDir(skillsDir)
        if (!skills.ok) return { dirs: new Map(), unreadable: skills.code }
        if (!skills.value) continue
        const current = bestVersion.get(plugin)
        if (current === undefined || compareVersions(version, current.version) > 0) {
          bestVersion.set(plugin, { version, dir: skillsDir })
        }
      }
    }
  }

  return { dirs: new Map([...bestVersion].map(([plugin, best]) => [plugin, best.dir])), unreadable: null }
}

/**
 * The live skills directory of one plugin (`plugin:<name>`'s source), or `null` when the cache has
 * no readable version of it. Same resolution the catalog scan uses -- see
 * {@link bestPluginVersionDirs}.
 */
export function highestPluginVersionDir(roots: SkillRoots, plugin: string): string | null {
  const best = bestPluginVersionDirs(roots.pluginCache)
  if (best.unreadable !== null) return null
  return best.dirs.get(plugin) ?? null
}

/**
 * Where a catalogued skill's files actually live, from the provider name the catalog recorded
 * (M37 §4). `null` means "this process cannot say" -- an unknown provider name, or a plugin whose
 * cache entry is gone -- and the caller records the skill as missing rather than guessing a path.
 *
 * The returned path is not checked for existence: the caller (`buildRunContext`) has to tell
 * "no source" from "a source that vanished" for its own manifest either way, so a stat here would
 * be a second, weaker version of a check it already makes.
 */
export function skillSourceDir(roots: SkillRoots, providerName: string, skillName: string): string | null {
  if (providerName === 'personal') return join(roots.personal, skillName)
  if (providerName === 'project') return join(roots.project, skillName)
  if (providerName.startsWith('plugin:')) {
    const dir = highestPluginVersionDir(roots, providerName.slice('plugin:'.length))
    return dir === null ? null : join(dir, skillName)
  }
  return null
}

/** `<cache>/<marketplace>/<plugin>/<version>/skills/*` -- the highest version of each plugin wins. */
function scanPluginCache(cacheDir: string): Scan {
  const best = bestPluginVersionDirs(cacheDir)
  if (best.unreadable !== null) return { found: [], unreadable: best.unreadable }

  const found: Found[] = []
  for (const [plugin, dir] of best.dirs) {
    const scan = scanSkillsDir(dir, `plugin:${plugin}`)
    if (scan.unreadable !== null) return { found: [], unreadable: scan.unreadable }
    found.push(...scan.found)
  }
  return { found, unreadable: null }
}

/**
 * Reads the daemon host's disk into `SkillProvider`/`Skill`, and NEVER deletes (Decision 6).
 *
 * Runs at daemon start and from `orchestrator skills sync`. A missing root is not an error --
 * a machine with no personal skills directory is an ordinary machine, and throwing there would
 * stop the daemon from starting.
 */
export async function syncSkillCatalog(roots?: Partial<SkillRoots>): Promise<SyncResult> {
  // `skillRoots()`, not `defaultRoots()` (M37 Task 2): the catalog and the injection have to read
  // the same disk. A daemon whose {@link SKILL_ROOTS_ENV} pointed the injection at a temp tree
  // while the catalog still scanned `~/.claude` would offer a slave skills it then failed to copy.
  const resolved: SkillRoots = { ...skillRoots(), ...roots }
  const scans: readonly { root: SkillRootName; path: string; scan: Scan }[] = [
    { root: 'personal', path: resolved.personal, scan: scanSkillsDir(resolved.personal, 'personal') },
    { root: 'pluginCache', path: resolved.pluginCache, scan: scanPluginCache(resolved.pluginCache) },
    { root: 'project', path: resolved.project, scan: scanSkillsDir(resolved.project, 'project') },
  ]
  const skippedRoots: readonly SkippedRoot[] = scans
    .filter((entry) => entry.scan.unreadable !== null)
    .map((entry) => ({ root: entry.root, path: entry.path, code: entry.scan.unreadable ?? 'UNKNOWN' }))
  const found = scans.flatMap((entry) => [...entry.scan.found])

  const providerNames = [...new Set(found.map((f) => f.provider))]
  const providerIds = new Map<string, string>()
  for (const name of providerNames) {
    const row = await prisma.skillProvider.upsert({ where: { name }, update: {}, create: { name } })
    providerIds.set(name, row.id)
  }

  const seen = new Set<string>()
  for (const skill of found) {
    const providerId = providerIds.get(skill.provider)
    if (providerId === undefined) continue
    const row = await prisma.skill.upsert({
      where: { providerId_name: { providerId, name: skill.name } },
      // `missingSince: null` on EVERY upsert, not only when it was set: a skill that came back is
      // present again, and leaving the stamp would show it as missing forever.
      update: { description: skill.description, missingSince: null },
      create: { providerId, name: skill.name, description: skill.description },
    })
    seen.add(row.id)
  }

  // Scoped to the providers whose root was ACTUALLY READ this pass. A root that threw taught us
  // nothing about what is on it, so its providers are excluded here and their skills keep whatever
  // they had -- the alternative is stamping a whole provider missing on a transient EACCES, which
  // is indistinguishable from a real mass-deletion to everything downstream.
  const readRoots = new Set(scans.filter((entry) => entry.scan.unreadable === null).map((entry) => entry.root))
  const scope = [
    readRoots.has('personal') ? { name: 'personal' } : null,
    readRoots.has('project') ? { name: 'project' } : null,
    // The plugin cache owns every `plugin:*` provider, including ones no longer on disk -- matched
    // by prefix rather than by what this pass found, or a plugin that vanished entirely would
    // never be marked at all.
    readRoots.has('pluginCache') ? { name: { startsWith: 'plugin:' } } : null,
  ].filter((filter) => filter !== null)

  let markedMissing = 0
  if (scope.length > 0) {
    const scoped = await prisma.skillProvider.findMany({ where: { OR: scope }, select: { id: true } })
    // Conditional on `missingSince: null` so a skill that has been gone for a week keeps the date
    // it actually vanished rather than being re-stamped with today's on every scan.
    const marked = await prisma.skill.updateMany({
      where: { providerId: { in: scoped.map((provider) => provider.id) }, id: { notIn: [...seen] }, missingSince: null },
      data: { missingSince: new Date() },
    })
    markedMissing = marked.count
  }

  return { providers: providerNames.length, upserted: seen.size, markedMissing, skippedRoots }
}

/**
 * The operator-facing line(s) for a sync, shared by `orchestrator skills sync` and the daemon's
 * startup hook so the two can never drift into reporting the same scan differently.
 *
 * The skipped roots get their OWN line: a sync that quietly reported `0 marked missing` while
 * having read only two of three roots would be telling the truth and still misleading.
 */
export function describeSync(result: SyncResult): string {
  const head = `skill catalog synced: ${result.providers} provider(s), ${result.upserted} skill(s), ${result.markedMissing} marked missing\n`
  if (result.skippedRoots.length === 0) return head
  const detail = result.skippedRoots.map((skipped) => `${skipped.root} (${skipped.path}): ${skipped.code}`).join('; ')
  return `${head}skipped ${result.skippedRoots.length} unreadable root(s), nothing marked missing under them: ${detail}\n`
}

/** Gives a slave a skill. Idempotent: the composite primary key `(slaveId, skillId)` makes a
 *  second call a no-op rather than a duplicate row. */
export async function assignSkill(slaveId: string, skillId: string): Promise<Result<void, ControlRefusal>> {
  const skill = await prisma.skill.findUnique({ where: { id: skillId }, select: { id: true } })
  if (skill === null) return err({ kind: 'skill_not_found', skillId })
  const slave = await prisma.slave.findUnique({ where: { id: slaveId }, select: { id: true } })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  await prisma.slaveSkill.upsert({
    where: { slaveId_skillId: { slaveId, skillId } },
    update: {},
    create: { slaveId, skillId },
  })
  return ok(undefined)
}

/** Takes it away. Idempotent for the same reason, via `deleteMany` rather than `delete` (which
 *  throws on a row that is already gone). */
export async function unassignSkill(slaveId: string, skillId: string): Promise<Result<void, ControlRefusal>> {
  const skill = await prisma.skill.findUnique({ where: { id: skillId }, select: { id: true } })
  if (skill === null) return err({ kind: 'skill_not_found', skillId })
  const slave = await prisma.slave.findUnique({ where: { id: slaveId }, select: { id: true } })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })

  await prisma.slaveSkill.deleteMany({ where: { slaveId, skillId } })
  return ok(undefined)
}
