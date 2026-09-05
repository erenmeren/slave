import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import { assignSkill, syncSkillCatalog, unassignSkill } from '../../src/skills.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "AgentSkill", "Skill", "SkillProvider", "AgentPermission", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE'

let root: string

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  )
}

function roots(): { personal: string; pluginCache: string; project: string } {
  return { personal: join(root, 'personal'), pluginCache: join(root, 'plugins'), project: join(root, 'project') }
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

describe('assignSkill / unassignSkill', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('refuses an unknown skill with the verbatim text, and an unknown agent with its own', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/x', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
    const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })

    const noSkill = await assignSkill(agent.id, '00000000-0000-4000-8000-000000000000')
    expect(noSkill.ok).toBe(false)
    if (!noSkill.ok) {
      expect(noSkill.error.kind).toBe('skill_not_found')
      expect(refusalText(noSkill.error)).toBe('no skill with id 00000000-0000-4000-8000-000000000000')
    }

    const provider = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const skill = await prisma.skill.create({ data: { providerId: provider.id, name: 'n', description: 'd' } })
    const noAgent = await assignSkill('00000000-0000-4000-8000-000000000000', skill.id)
    expect(noAgent.ok).toBe(false)
    if (!noAgent.ok) expect(noAgent.error.kind).toBe('agent_not_found')
  })

  it('is idempotent in both directions', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/x', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
    const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
    const provider = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const skill = await prisma.skill.create({ data: { providerId: provider.id, name: 'n', description: 'd' } })

    expect((await assignSkill(agent.id, skill.id)).ok).toBe(true)
    expect((await assignSkill(agent.id, skill.id)).ok).toBe(true)
    expect(await prisma.agentSkill.count({ where: { agentId: agent.id } })).toBe(1)

    expect((await unassignSkill(agent.id, skill.id)).ok).toBe(true)
    expect((await unassignSkill(agent.id, skill.id)).ok).toBe(true)
    expect(await prisma.agentSkill.count({ where: { agentId: agent.id } })).toBe(0)
  })
})
