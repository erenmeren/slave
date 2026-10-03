import { describe, expect, it } from 'vitest'
import { planFileGrant, type GrantPackage } from '../../src/conduct/grant.js'
import { isOwned, ownershipRuleFor } from '../../src/conduct/ownership.js'

const pkg = (key: string, ownedPaths: string[], extra: Partial<GrantPackage> = {}): GrantPackage => ({ key, ownedPaths, releasedPaths: [], isIntegration: key === 'integration', registrations: [], ...extra })
const VERSION = [
  pkg('skeleton', ['backend/package.json', 'backend/package-lock.json', 'scripts/verify.sh']),
  pkg('api', ['src/api/**', 'src/api/index.ts']),
  pkg('web', ['src/web/**']),
  pkg('db', ['backend/migrations/0001_init.sql'], { registrations: [{ directory: 'backend/migrations', prefix: '01_' }] }),
  pkg('integration', []),
]

/** The package set after a grant's changes are written, as Task 5 writes them. */
const applied = (packages: readonly GrantPackage[], changes: readonly { readonly key: string }[]): GrantPackage[] =>
  packages.map((p) => ({ ...p, ...(changes.find((c) => c.key === p.key) ?? {}) }))

/** The keys whose ownership rule owns `path`. */
const ownersOf = (packages: readonly GrantPackage[], path: string): string[] =>
  packages.filter((p) => {
    const rule = ownershipRuleFor(p, packages)
    return rule !== null && isOwned(rule, path)
  }).map((p) => p.key)

describe('planFileGrant (human cards H2.4, plan B D5)', () => {
  it('moves a glob-owned file by releasing it from its owner', () => {
    const granted = planFileGrant({ path: 'src/api/routes.ts', toKey: 'web', packages: VERSION })
    expect(granted.ok && granted.value).toEqual({
      path: 'src/api/routes.ts',
      fromKey: 'api',
      toKey: 'web',
      changes: [
        { key: 'api', ownedPaths: ['src/api/**', 'src/api/index.ts'], releasedPaths: ['src/api/routes.ts'] },
        { key: 'web', ownedPaths: ['src/web/**', 'src/api/routes.ts'], releasedPaths: [] },
      ],
    })
    const after = VERSION.map((p) => {
      const change = granted.ok ? granted.value.changes.find((c) => c.key === p.key) : undefined
      return change === undefined ? p : { ...p, ...change }
    })
    const api = after.find((p) => p.key === 'api')
    const web = after.find((p) => p.key === 'web')
    expect(api !== undefined && isOwned(ownershipRuleFor(api, after) ?? { owned: null, excluded: [] }, 'src/api/routes.ts')).toBe(false)
    expect(web !== undefined && isOwned(ownershipRuleFor(web, after) ?? { owned: null, excluded: [] }, 'src/api/routes.ts')).toBe(true)
  })

  it('moves a file owned by name by taking the name away', () => {
    const granted = planFileGrant({ path: 'src/api/index.ts', toKey: 'web', packages: VERSION })
    expect(granted.ok && granted.value.changes.find((c) => c.key === 'api')).toEqual({ key: 'api', ownedPaths: ['src/api/**'], releasedPaths: ['src/api/index.ts'] })
  })

  it('takes a file nobody owns from the integration package by giving it to the target', () => {
    const granted = planFileGrant({ path: 'Dockerfile', toKey: 'web', packages: VERSION })
    expect(granted.ok && granted.value).toMatchObject({ fromKey: 'integration', changes: [{ key: 'web', ownedPaths: ['src/web/**', 'Dockerfile'], releasedPaths: [] }] })
  })

  it('gives a released file back to the package that released it, and it owns it again', () => {
    const first = planFileGrant({ path: 'src/api/routes.ts', toKey: 'web', packages: VERSION })
    if (!first.ok) throw new Error(first.error)
    const moved = applied(VERSION, first.value.changes)
    const back = planFileGrant({ path: 'src/api/routes.ts', toKey: 'api', packages: moved })
    if (!back.ok) throw new Error(back.error)
    expect(back.value).toMatchObject({ fromKey: 'web', toKey: 'api' })
    const restored = applied(moved, back.value.changes)
    expect(restored.find((p) => p.key === 'api')).toMatchObject({ releasedPaths: [] })
    expect(restored.find((p) => p.key === 'web')).toMatchObject({ ownedPaths: ['src/web/**'], releasedPaths: [] })
    expect(ownersOf(restored, 'src/api/routes.ts')).toEqual(['api'])
  })

  it('gives a file owned by name only to the integration package, which then owns it', () => {
    const granted = planFileGrant({ path: 'scripts/verify.sh', toKey: 'integration', packages: VERSION })
    if (!granted.ok) throw new Error(granted.error)
    expect(granted.value).toMatchObject({ fromKey: 'skeleton', toKey: 'integration' })
    expect(ownersOf(applied(VERSION, granted.value.changes), 'scripts/verify.sh')).toEqual(['integration'])
  })

  it('refuses what the rules refuse, naming why', () => {
    const refused = (path: string, toKey: string, packages = VERSION): string => {
      const result = planFileGrant({ path, toKey, packages })
      return result.ok ? 'granted' : result.error
    }
    expect(refused('src/**', 'web')).toContain('not one repository file')
    expect(refused('../etc/passwd', 'web')).toContain('not one repository file')
    expect(refused('src/web/a.ts', 'web')).toContain('already owns')
    expect(refused('src/a.ts', 'nobody')).toContain('no package has the key')
    expect(refused('backend/package.json', 'api')).toContain('belong to the skeleton package')
    expect(refused('src/api/routes.ts', 'integration')).toContain('the integration package')
    expect(refused('backend/migrations/01_users.sql', 'api')).toContain('file-per-package')
    expect(refused('a.ts', 'main', [pkg('main', ['**'])])).toContain('one package owns every file')
  })

  it('refuses the integration package a file its owner holds by name and by a glob, which no one would then own', () => {
    // `src/api/index.ts` is both named and under `src/api/**`: taking the name leaves the glob, and
    // the integration package's rule excludes every other package's globs, so nobody would own it.
    const refused = planFileGrant({ path: 'src/api/index.ts', toKey: 'integration', packages: VERSION })
    expect(refused.ok ? 'granted' : refused.error).toContain('the integration package')
  })

  it('refuses the integration package a file released from a glob earlier, which its rule still excludes', () => {
    const first = planFileGrant({ path: 'src/api/routes.ts', toKey: 'web', packages: VERSION })
    if (!first.ok) throw new Error(first.error)
    const refused = planFileGrant({ path: 'src/api/routes.ts', toKey: 'integration', packages: applied(VERSION, first.value.changes) })
    expect(refused.ok ? 'granted' : refused.error).toContain('the integration package owns only files')
  })
})
