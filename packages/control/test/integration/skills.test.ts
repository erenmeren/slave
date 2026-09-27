import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SKILL_ROOTS_ENV,
  highestPluginVersionDir,
  skillRoots,
  skillSourceDir,
  syncSkillCatalog,
} from '../../src/skills.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "PersonSkill", "TemplateSkill", "Skill", "SkillProvider", "SlavePermission", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'

let root: string

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  )
}

function roots(): { personal: string; pluginCache: string; project: string; library: string } {
  return {
    personal: join(root, 'personal'),
    pluginCache: join(root, 'plugins'),
    project: join(root, 'project'),
    library: join(root, 'library'),
  }
}

describe('syncSkillCatalog', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
    // A temp tree, never the operator's real `~/.claude` -- `syncSkillCatalog` takes its roots as
    // an argument precisely so a test never reads (or reports on) the host it happens to run on.
    root = mkdtempSync(join(tmpdir(), 'slaveofai-skills-'))
    mkdirSync(roots().personal, { recursive: true })
    mkdirSync(roots().pluginCache, { recursive: true })
    mkdirSync(roots().project, { recursive: true })
  })

  afterEach((): void => {
    rmSync(root, { recursive: true, force: true })
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('reads frontmatter name and description under the three provider names', async (): Promise<void> => {
    writeSkill(roots().personal, 'my-notes', 'my own notes skill')
    mkdirSync(join(roots().pluginCache, 'marketplace/superpowers/6.3.0/skills'), { recursive: true })
    writeSkill(join(roots().pluginCache, 'marketplace/superpowers/6.3.0/skills'), 'writing-plans', 'plans things')
    writeSkill(roots().project, 'house-style', 'this repo house style')

    const result = await syncSkillCatalog(roots())
    expect(result.providers).toBe(3)
    expect(result.upserted).toBe(3)

    const providers = await prisma.skillProvider.findMany({ include: { skills: true }, orderBy: { name: 'asc' } })
    expect(providers.map((p) => p.name)).toEqual(['personal', 'plugin:superpowers', 'project'])
    const plugin = providers.find((p) => p.name === 'plugin:superpowers')
    expect(plugin?.skills[0]?.name).toBe('writing-plans')
    expect(plugin?.skills[0]?.description).toBe('plans things')
  })

  it('reads the skill library as one provider per source, library:<source>', async (): Promise<void> => {
    writeSkill(join(roots().library, 'trailofbits'), 'sharp-edges', 'finds footguns')
    writeSkill(join(roots().library, 'sentry'), 'find-bugs', 'finds bugs')
    writeSkill(roots().personal, 'my-notes', 'my own notes skill')

    const result = await syncSkillCatalog(roots())
    expect(result.upserted).toBe(3)
    const providers = await prisma.skillProvider.findMany({ include: { skills: true }, orderBy: { name: 'asc' } })
    expect(providers.map((p) => p.name)).toEqual(['library:sentry', 'library:trailofbits', 'personal'])
    expect(providers.find((p) => p.name === 'library:trailofbits')?.skills[0]?.name).toBe('sharp-edges')
  })

  it('marks a library skill missing when its source directory is removed', async (): Promise<void> => {
    writeSkill(join(roots().library, 'sentry'), 'find-bugs', 'finds bugs')
    await syncSkillCatalog(roots())
    rmSync(join(roots().library, 'sentry'), { recursive: true, force: true })

    const result = await syncSkillCatalog(roots())
    expect(result.markedMissing).toBe(1)
    const skill = await prisma.skill.findFirstOrThrow({ where: { name: 'find-bugs' } })
    expect(skill.missingSince).not.toBeNull()
  })

  it('leaves library skills alone when no library root is configured', async (): Promise<void> => {
    writeSkill(join(roots().library, 'sentry'), 'find-bugs', 'finds bugs')
    await syncSkillCatalog(roots())

    const { library: _library, ...withoutLibrary } = roots()
    const result = await syncSkillCatalog({ ...withoutLibrary, library: undefined })
    expect(result.markedMissing).toBe(0)
    const skill = await prisma.skill.findFirstOrThrow({ where: { name: 'find-bugs' } })
    expect(skill.missingSince).toBeNull()
  })

  it('reads a quoted description as its text, without the quotes', async (): Promise<void> => {
    // The real SKILL.md files in the plugin cache quote the description; the personal ones often
    // do not. Both grammars are the same field.
    mkdirSync(join(roots().personal, 'quoted'), { recursive: true })
    writeFileSync(
      join(roots().personal, 'quoted', 'SKILL.md'),
      '---\nname: quoted\ndescription: "You MUST use this before any creative work."\n---\n\n# quoted\n',
    )
    await syncSkillCatalog(roots())
    const skill = await prisma.skill.findFirstOrThrow({ where: { name: 'quoted' } })
    expect(skill.description).toBe('You MUST use this before any creative work.')
  })

  it('takes the highest version of a plugin, never a lower one', async (): Promise<void> => {
    for (const version of ['6.3.0', '10.0.1', '9.9.9']) {
      mkdirSync(join(roots().pluginCache, `mkt/superpowers/${version}/skills`), { recursive: true })
      writeSkill(join(roots().pluginCache, `mkt/superpowers/${version}/skills`), 'writing-plans', `from ${version}`)
    }
    await syncSkillCatalog(roots())
    const skill = await prisma.skill.findFirstOrThrow({ where: { name: 'writing-plans' } })
    // Numeric comparison, not lexicographic: '9.9.9' > '10.0.1' as strings, and that is the bug
    // this pins.
    expect(skill.description).toBe('from 10.0.1')
  })

  it('prefers a numbered version over an unnumbered one', async (): Promise<void> => {
    // This host's own cache holds `frontend-design/unknown` beside commit-sha directories: a
    // version that is not a number must never outrank one that is.
    for (const version of ['unknown', '1.0.0']) {
      mkdirSync(join(roots().pluginCache, `mkt/frontend-design/${version}/skills`), { recursive: true })
      writeSkill(join(roots().pluginCache, `mkt/frontend-design/${version}/skills`), 'fd', `from ${version}`)
    }
    await syncSkillCatalog(roots())
    const skill = await prisma.skill.findFirstOrThrow({ where: { name: 'fd' } })
    expect(skill.description).toBe('from 1.0.0')
  })

  it('updates an existing row rather than duplicating it', async (): Promise<void> => {
    writeSkill(roots().personal, 'my-notes', 'first')
    await syncSkillCatalog(roots())
    writeSkill(roots().personal, 'my-notes', 'second')
    await syncSkillCatalog(roots())

    const skills = await prisma.skill.findMany({ where: { name: 'my-notes' } })
    expect(skills).toHaveLength(1)
    expect(skills[0]?.description).toBe('second')
  })

  it('marks a vanished skill missing rather than deleting it, and clears the mark when it returns', async (): Promise<void> => {
    writeSkill(roots().personal, 'my-notes', 'notes')
    await syncSkillCatalog(roots())
    rmSync(join(roots().personal, 'my-notes'), { recursive: true, force: true })

    const second = await syncSkillCatalog(roots())
    expect(second.markedMissing).toBe(1)
    const missing = await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })
    expect(missing.missingSince).not.toBeNull()

    writeSkill(roots().personal, 'my-notes', 'notes')
    await syncSkillCatalog(roots())
    expect((await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })).missingSince).toBeNull()
  })

  it('does not re-stamp missingSince on a skill that was already missing', async (): Promise<void> => {
    writeSkill(roots().personal, 'my-notes', 'notes')
    await syncSkillCatalog(roots())
    rmSync(join(roots().personal, 'my-notes'), { recursive: true, force: true })
    await syncSkillCatalog(roots())
    const first = (await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })).missingSince
    await syncSkillCatalog(roots())
    expect((await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })).missingSince).toEqual(first)
  })

  it('ignores a directory with no SKILL.md and a SKILL.md with no name', async (): Promise<void> => {
    mkdirSync(join(roots().personal, 'not-a-skill'), { recursive: true })
    mkdirSync(join(roots().personal, 'headless'), { recursive: true })
    writeFileSync(join(roots().personal, 'headless/SKILL.md'), '# no frontmatter here\n')
    const result = await syncSkillCatalog(roots())
    expect(result.upserted).toBe(0)
  })

  // `chmod 000` is not a permission the superuser observes, so the case this pins cannot be
  // constructed as root.
  it.skipIf(process.getuid?.() === 0)(
    'skips a root it cannot read rather than declaring its skills gone',
    async (): Promise<void> => {
      writeSkill(roots().personal, 'my-notes', 'notes')
      writeSkill(roots().project, 'house-style', 'house style')
      await syncSkillCatalog(roots())

      chmodSync(roots().personal, 0o000)
      try {
        const second = await syncSkillCatalog(roots())

        // The distinction the catalog must not blur: unreadable is not gone. A transient EACCES on
        // one root would otherwise stamp every skill under it as vanished, which reads exactly like
        // a real mass-deletion.
        expect(second.skippedRoots).toEqual([{ root: 'personal', path: roots().personal, code: 'EACCES' }])
        expect(second.markedMissing).toBe(0)
        expect((await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })).missingSince).toBeNull()
        // ...and the roots it COULD read are still synced: one unreadable root is not a failed scan.
        expect(second.upserted).toBe(1)
        expect((await prisma.skill.findFirstOrThrow({ where: { name: 'house-style' } })).missingSince).toBeNull()
      } finally {
        chmodSync(roots().personal, 0o700)
      }
    },
  )

  it('still marks skills missing when their root is genuinely absent', async (): Promise<void> => {
    writeSkill(roots().personal, 'my-notes', 'notes')
    await syncSkillCatalog(roots())
    rmSync(roots().personal, { recursive: true, force: true })

    const second = await syncSkillCatalog(roots())
    expect(second.skippedRoots).toEqual([])
    expect(second.markedMissing).toBe(1)
    expect((await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })).missingSince).not.toBeNull()
  })

  it('survives a root that does not exist at all', async (): Promise<void> => {
    rmSync(roots().project, { recursive: true, force: true })
    await expect(syncSkillCatalog(roots())).resolves.toMatchObject({ upserted: 0 })
  })
})

/**
 * Where a catalogued skill's FILES are, which is what M37's dispatch copies into a worktree. The
 * catalog scan and this resolver walk the plugin cache through the same helper on purpose -- two
 * walks would be two answers to "which version is live", and a prompt could then name a skill from
 * a directory nothing copied.
 */
describe('skillSourceDir', () => {
  beforeEach((): void => {
    root = mkdtempSync(join(tmpdir(), 'slaveofai-skills-'))
    mkdirSync(roots().personal, { recursive: true })
    mkdirSync(roots().pluginCache, { recursive: true })
    mkdirSync(roots().project, { recursive: true })
  })

  afterEach((): void => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves the personal and project roots by provider name', (): void => {
    expect(skillSourceDir(roots(), 'personal', 'my-notes')).toBe(join(roots().personal, 'my-notes'))
    expect(skillSourceDir(roots(), 'project', 'house-style')).toBe(join(roots().project, 'house-style'))
  })

  it('resolves a library skill under its source, and nothing when no library root is configured', (): void => {
    expect(skillSourceDir(roots(), 'library:trailofbits', 'sharp-edges')).toBe(
      join(roots().library, 'trailofbits', 'sharp-edges'),
    )
    const { library: _library, ...withoutLibrary } = roots()
    expect(skillSourceDir(withoutLibrary, 'library:trailofbits', 'sharp-edges')).toBeNull()
    expect(skillSourceDir(roots(), 'library:', 'sharp-edges')).toBeNull()
    expect(skillSourceDir(roots(), 'library:../escape', 'sharp-edges')).toBeNull()
  })

  it('resolves a plugin skill to the highest version on disk, the same one the scan catalogued', async (): Promise<void> => {
    for (const version of ['9.9.9', '10.0.1']) {
      const dir = join(roots().pluginCache, 'marketplace/superpowers', version, 'skills')
      mkdirSync(dir, { recursive: true })
      writeSkill(dir, 'writing-plans', `plans things (${version})`)
    }

    const resolved = skillSourceDir(roots(), 'plugin:superpowers', 'writing-plans')
    expect(resolved).toBe(join(roots().pluginCache, 'marketplace/superpowers/10.0.1/skills', 'writing-plans'))
    expect(highestPluginVersionDir(roots(), 'superpowers')).toBe(
      join(roots().pluginCache, 'marketplace/superpowers/10.0.1/skills'),
    )

    // And it is the version the catalog recorded, not merely the one this function likes.
    await prisma.$executeRawUnsafe(TRUNCATE)
    await syncSkillCatalog(roots())
    const skill = await prisma.skill.findFirstOrThrow({ where: { name: 'writing-plans' } })
    expect(skill.description).toBe('plans things (10.0.1)')
  })

  it('says nothing rather than guessing for a provider it does not know, or a plugin with no cache entry', (): void => {
    expect(skillSourceDir(roots(), 'plugin:not-installed', 'x')).toBeNull()
    expect(skillSourceDir(roots(), 'imported-from-somewhere', 'x')).toBeNull()
  })
})

describe('skillRoots', () => {
  afterEach((): void => {
    delete process.env[SKILL_ROOTS_ENV]
  })

  it('reads the three roots out of the environment when it is set', (): void => {
    process.env[SKILL_ROOTS_ENV] = JSON.stringify({ personal: '/a', pluginCache: '/b', project: '/c' })
    expect(skillRoots()).toEqual({ personal: '/a', pluginCache: '/b', project: '/c' })
  })

  it('falls back to the host layout when it is not set', (): void => {
    delete process.env[SKILL_ROOTS_ENV]
    expect(skillRoots().personal).toBe(join(homedir(), '.claude', 'skills'))
    expect(skillRoots().library).toBe(join(homedir(), '.slaveofai', 'skill-library'))
  })

  it('reads an optional library root out of the environment, and never falls back to the real one', (): void => {
    process.env[SKILL_ROOTS_ENV] = JSON.stringify({ personal: '/a', pluginCache: '/b', project: '/c', library: '/d' })
    expect(skillRoots().library).toBe('/d')
    process.env[SKILL_ROOTS_ENV] = JSON.stringify({ personal: '/a', pluginCache: '/b', project: '/c' })
    expect(skillRoots().library).toBeUndefined()
    process.env[SKILL_ROOTS_ENV] = JSON.stringify({ personal: '/a', pluginCache: '/b', project: '/c', library: '' })
    expect(() => skillRoots()).toThrow('library')
  })

  it('throws rather than silently reading the operator\'s real skills when the value is malformed', (): void => {
    // The whole point of the seam is that a gate never touches `~/.claude`. Falling back on a typo
    // would do exactly that, invisibly.
    process.env[SKILL_ROOTS_ENV] = 'not json'
    expect(() => skillRoots()).toThrow(SKILL_ROOTS_ENV)
    process.env[SKILL_ROOTS_ENV] = JSON.stringify({ personal: '/a' })
    expect(() => skillRoots()).toThrow('pluginCache')
  })
})
