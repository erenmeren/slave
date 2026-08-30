import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
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

export interface SyncResult {
  readonly providers: number
  readonly upserted: number
  /** Skills present in the DB but absent from disk this scan; each got `missingSince` set. */
  readonly markedMissing: number
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

function readDirs(dir: string): readonly string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Every `<dir>/<skill>/SKILL.md` under one skills directory, as `Found` rows for `provider`. */
function scanSkillsDir(dir: string, provider: string): readonly Found[] {
  const found: Found[] = []
  for (const name of readDirs(dir)) {
    const path = join(dir, name, 'SKILL.md')
    if (!existsSync(path)) continue
    let parsed: { name: string; description: string } | null = null
    try {
      parsed = parseFrontmatter(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (parsed === null) continue
    found.push({ provider, name: parsed.name, description: parsed.description })
  }
  return found
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

/** `<cache>/<marketplace>/<plugin>/<version>/skills/*` -- the highest version of each plugin wins. */
function scanPluginCache(cacheDir: string): readonly Found[] {
  const bestVersion = new Map<string, { version: string; dir: string }>()
  for (const marketplace of readDirs(cacheDir)) {
    for (const plugin of readDirs(join(cacheDir, marketplace))) {
      for (const version of readDirs(join(cacheDir, marketplace, plugin))) {
        const skillsDir = join(cacheDir, marketplace, plugin, version, 'skills')
        if (!existsSync(skillsDir)) continue
        const current = bestVersion.get(plugin)
        if (current === undefined || compareVersions(version, current.version) > 0) {
          bestVersion.set(plugin, { version, dir: skillsDir })
        }
      }
    }
  }
  return [...bestVersion.entries()].flatMap(([plugin, { dir }]) => scanSkillsDir(dir, `plugin:${plugin}`))
}

/**
 * Reads the daemon host's disk into `SkillProvider`/`Skill`, and NEVER deletes (Decision 6).
 *
 * Runs at daemon start and from `orchestrator skills sync`. A missing root is not an error --
 * a machine with no personal skills directory is an ordinary machine, and throwing there would
 * stop the daemon from starting.
 */
export async function syncSkillCatalog(roots?: Partial<SkillRoots>): Promise<SyncResult> {
  const resolved: SkillRoots = { ...defaultRoots(), ...roots }
  const found = [
    ...scanSkillsDir(resolved.personal, 'personal'),
    ...scanPluginCache(resolved.pluginCache),
    ...scanSkillsDir(resolved.project, 'project'),
  ]

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

  // Conditional on `missingSince: null` so a skill that has been gone for a week keeps the date it
  // actually vanished rather than being re-stamped with today's on every scan.
  const marked = await prisma.skill.updateMany({
    where: { id: { notIn: [...seen] }, missingSince: null },
    data: { missingSince: new Date() },
  })

  return { providers: providerNames.length, upserted: seen.size, markedMissing: marked.count }
}

/** Gives an agent a skill. Idempotent: the composite primary key `(agentId, skillId)` makes a
 *  second call a no-op rather than a duplicate row. */
export async function assignSkill(agentId: string, skillId: string): Promise<Result<void, ControlRefusal>> {
  const skill = await prisma.skill.findUnique({ where: { id: skillId }, select: { id: true } })
  if (skill === null) return err({ kind: 'skill_not_found', skillId })
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } })
  if (agent === null) return err({ kind: 'agent_not_found', agentId })

  await prisma.agentSkill.upsert({
    where: { agentId_skillId: { agentId, skillId } },
    update: {},
    create: { agentId, skillId },
  })
  return ok(undefined)
}

/** Takes it away. Idempotent for the same reason, via `deleteMany` rather than `delete` (which
 *  throws on a row that is already gone). */
export async function unassignSkill(agentId: string, skillId: string): Promise<Result<void, ControlRefusal>> {
  const skill = await prisma.skill.findUnique({ where: { id: skillId }, select: { id: true } })
  if (skill === null) return err({ kind: 'skill_not_found', skillId })
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } })
  if (agent === null) return err({ kind: 'agent_not_found', agentId })

  await prisma.agentSkill.deleteMany({ where: { agentId, skillId } })
  return ok(undefined)
}
