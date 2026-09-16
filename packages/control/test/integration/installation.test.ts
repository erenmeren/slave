import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import { resolveReposRoot, setInstallationSettings, slugify } from '../../src/installation.js'

describe('the repositories folder', () => {
  const original = process.env['SLAVEOFAI_REPOS']

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "InstallationSettings" RESTART IDENTITY CASCADE')
    delete process.env['SLAVEOFAI_REPOS']
  })

  afterEach((): void => {
    if (original === undefined) delete process.env['SLAVEOFAI_REPOS']
    else process.env['SLAVEOFAI_REPOS'] = original
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('falls back to ~/projects when nothing is configured, and says so', async (): Promise<void> => {
    expect(await resolveReposRoot()).toEqual({ root: join(homedir(), 'projects'), source: 'default' })
  })

  it('prefers SLAVEOFAI_REPOS over the default', async (): Promise<void> => {
    process.env['SLAVEOFAI_REPOS'] = '/srv/repos'
    expect(await resolveReposRoot()).toEqual({ root: '/srv/repos', source: 'env' })
  })

  it('prefers the stored row over both', async (): Promise<void> => {
    process.env['SLAVEOFAI_REPOS'] = '/srv/repos'
    const saved = await setInstallationSettings({ reposRoot: '/home/me/code' })
    expect(saved.ok).toBe(true)
    expect(await resolveReposRoot()).toEqual({ root: '/home/me/code', source: 'settings' })
  })

  it('clearing the row falls back to the environment again', async (): Promise<void> => {
    process.env['SLAVEOFAI_REPOS'] = '/srv/repos'
    await setInstallationSettings({ reposRoot: '/home/me/code' })
    await setInstallationSettings({ reposRoot: null })
    expect(await resolveReposRoot()).toEqual({ root: '/srv/repos', source: 'env' })
  })

  it('keeps exactly one row however often it is written', async (): Promise<void> => {
    await setInstallationSettings({ reposRoot: '/one' })
    await setInstallationSettings({ reposRoot: '/two' })
    expect(await prisma.installationSettings.count()).toBe(1)
  })

  it('refuses a relative path, and the sentence names the path', async (): Promise<void> => {
    const result = await setInstallationSettings({ reposRoot: 'code' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('invalid_repos_root')
    expect(refusalText(result.error)).toContain('code')
  })

  it('slugs a project name into something that can be a directory', (): void => {
    expect(slugify('Public API')).toBe('public-api')
    expect(slugify('  Checkout   Platform!! ')).toBe('checkout-platform')
    expect(slugify('Ödeme Sistemi')).toBe('odeme-sistemi')
    // Never empty and never a path: a name of nothing but punctuation would otherwise resolve
    // `<root>/<slug>` to the root itself and create a project AT the repositories folder.
    expect(slugify('***')).toBe('project')
    expect(slugify('../etc')).toBe('etc')
  })
})
