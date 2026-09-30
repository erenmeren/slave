import { describe, expect, it } from 'vitest'
import {
  MANIFEST_LOCK_PAIRS,
  gateRunsVerifyScript,
  hasProductFiles,
  isValidRegistration,
  manifestFamily,
  manifestProblems,
  registrationGlob,
  registrationProblems,
  skeletonPaths,
  verifyCheckPathFor,
} from '../../src/conduct/skeleton.js'

describe('manifestFamily', () => {
  it('is the manifest and every lockfile of its kind, in the same directory', () => {
    expect(manifestFamily('backend/package-lock.json')).toEqual([
      'backend/package.json', 'backend/package-lock.json', 'backend/npm-shrinkwrap.json', 'backend/pnpm-lock.yaml',
      'backend/yarn.lock', 'backend/bun.lockb', 'backend/bun.lock',
    ])
    expect(manifestFamily('Cargo.toml')).toEqual(['Cargo.toml', 'Cargo.lock'])
    expect(manifestFamily('svc/go.sum')).toEqual(['svc/go.mod', 'svc/go.sum'])
    expect(manifestFamily('src/app.ts')).toEqual([])
  })

  it('ignores a manifest under node_modules, vendor, fixtures, __fixtures__ or testdata', () => {
    for (const path of [
      'node_modules/left-pad/package.json',
      'vendor/github.com/x/go.mod',
      'test/fixtures/x/package.json',
      'src/__fixtures__/Cargo.lock',
      'pkg/testdata/go.sum',
    ]) {
      expect(manifestFamily(path)).toEqual([])
    }
    expect(manifestFamily('fixtures-tool/package.json')).toHaveLength(7) // a segment NAMED fixtures only
  })

  it('covers the spec S2 list exactly', () => {
    expect(MANIFEST_LOCK_PAIRS.map((p) => p.manifest)).toEqual(['package.json', 'pyproject.toml', 'Pipfile', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json'])
  })
})

describe('manifestProblems', () => {
  const known = ['backend/package.json', 'README.md']
  it('refuses a split pair, naming the family and the skeleton', () => {
    const problems = manifestProblems(
      [{ key: 'core', ownedPaths: ['backend/package.json'] }, { key: 'api', ownedPaths: ['backend/package-lock.json'] }],
      known,
    )
    expect(problems.join('\n')).toContain('package "core" owns backend/package.json')
    expect(problems.join('\n')).toContain('package "api" owns backend/package-lock.json')
    expect(problems.join('\n')).toContain('belong to the skeleton package')
  })
  it('refuses a glob that covers a lockfile that does not exist yet', () => {
    expect(manifestProblems([{ key: 'core', ownedPaths: ['backend/**'] }], known).join('\n')).toContain('backend/yarn.lock')
  })
  it('refuses a pair given as literal owned paths to two packages, though neither file exists yet', () => {
    const problems = manifestProblems(
      [{ key: 'api', ownedPaths: ['backend/package.json'] }, { key: 'ui', ownedPaths: ['backend/package-lock.json'] }],
      [],
    ).join('\n')
    expect(problems).toContain('package "api" owns backend/package.json, but backend/package.json, backend/package-lock.json')
    expect(problems).toContain('package "ui" owns backend/package-lock.json')
    expect(problems).toContain('belong to the skeleton package')
  })
  it('neither reserves a fixture manifest for the skeleton nor refuses a tests package that owns it', () => {
    const packages = [{ key: 'skeleton', ownedPaths: [] }, { key: 'tests', ownedPaths: ['test/**'] }]
    const repo = ['package.json', 'test/fixtures/x/package.json', 'test/fixtures/x/package-lock.json']
    expect(manifestProblems(packages, repo)).toEqual([])
    const { add } = skeletonPaths(packages, repo, true)
    expect(add).toContain('package.json')
    expect(add.filter((path) => path.startsWith('test/'))).toEqual([])
  })
  it('accepts the family in the skeleton', () => {
    expect(manifestProblems([{ key: 'skeleton', ownedPaths: ['backend/package.json', 'backend/package-lock.json'] }, { key: 'api', ownedPaths: ['backend/src/api/**'] }], known)).toEqual([])
  })
})

describe('skeletonPaths', () => {
  it('gives the fallback skeleton the scripts, unclaimed manifest families and unclaimed root build files', () => {
    const { add, problems } = skeletonPaths(
      [{ key: 'skeleton', ownedPaths: [] }, { key: 'web', ownedPaths: ['frontend/**', 'Dockerfile'] }],
      ['frontend/package.json', 'go.mod'],
      true,
    )
    expect(problems).toEqual([])
    expect(add).toEqual(expect.arrayContaining(['scripts/verify.sh', 'scripts/smoke.sh', 'go.mod', 'go.sum', 'compose.yaml', 'Makefile']))
    expect(add).not.toContain('frontend/package.json') // web's glob claims it: manifestProblems refuses that separately
    expect(add).not.toContain('Dockerfile')
  })
  it('refuses another package owning a gate script', () => {
    const { problems } = skeletonPaths([{ key: 'skeleton', ownedPaths: [] }, { key: 'ops', ownedPaths: ['scripts/**'] }], [], false)
    expect(problems).toEqual([
      'package "ops" owns scripts/verify.sh, which belongs to the skeleton package',
      'package "ops" owns scripts/smoke.sh, which belongs to the skeleton package',
    ])
  })
  it('adds no build file to a skeleton the conductor named', () => {
    expect(skeletonPaths([{ key: 'skeleton', ownedPaths: ['src/main.ts'] }], [], false).add).toEqual(['scripts/verify.sh', 'scripts/smoke.sh'])
  })
})

describe('registrations', () => {
  it('turns a registration into a prefix glob and validates it', () => {
    expect(registrationGlob({ directory: 'backend/migrations/', prefix: '0100_identity_' })).toBe('backend/migrations/0100_identity_*')
    expect(isValidRegistration({ directory: 'backend/migrations', prefix: '0100_' })).toBe(true)
    expect(isValidRegistration({ directory: 'backend/**', prefix: 'x' })).toBe(false)
    expect(isValidRegistration({ directory: 'backend/migrations', prefix: 'a/b' })).toBe(false)
    expect(isValidRegistration({ directory: '../up', prefix: 'x' })).toBe(false)
    expect(isValidRegistration({ directory: 'm', prefix: 'x'.repeat(41) })).toBe(false)
    expect(isValidRegistration({ directory: 'm/'.repeat(101), prefix: 'x' })).toBe(false)
  })
  it('refuses a directory that is not written the way git writes paths', () => {
    expect(isValidRegistration({ directory: './db/m', prefix: 'x' })).toBe(false)
    expect(isValidRegistration({ directory: 'db//m', prefix: 'x' })).toBe(false)
    expect(isValidRegistration({ directory: '.', prefix: 'x' })).toBe(false)
    expect(isValidRegistration({ directory: 'db/m/.', prefix: 'x' })).toBe(false)
    expect(isValidRegistration({ directory: 'db/./m', prefix: 'x' })).toBe(false)
    expect(isValidRegistration({ directory: 'db/m/', prefix: 'x' })).toBe(true)
  })
  it('refuses a whole shared directory owned by one package while another registers there', () => {
    const problems = registrationProblems([
      { key: 'core', ownedPaths: ['backend/migrations/**'], registrations: [] },
      { key: 'identity', ownedPaths: ['backend/migrations/0100_identity_*'], registrations: [{ directory: 'backend/migrations', prefix: '0100_identity_' }] },
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('package "core" owns files in backend/migrations that package "identity" registers there')
    expect(problems[0]).toContain('file-per-package')
  })
  it('refuses two prefixes where one is a prefix of the other', () => {
    expect(registrationProblems([
      { key: 'a', ownedPaths: ['m/01_*'], registrations: [{ directory: 'm', prefix: '01_' }] },
      { key: 'b', ownedPaths: ['m/01_b_*'], registrations: [{ directory: 'm', prefix: '01_b_' }] },
    ])).toHaveLength(1)
  })
  it('refuses an extension-limited glob over the shared directory', () => {
    const problems = registrationProblems([
      { key: 'a', ownedPaths: ['db/m/*.sql'], registrations: [] },
      { key: 'b', ownedPaths: ['db/m/02_b_*'], registrations: [{ directory: 'db/m', prefix: '02_b_' }] },
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('package "a" owns files in db/m that package "b" registers there')
  })
  it('refuses a recursive glob that covers the shared directory', () => {
    expect(registrationProblems([
      { key: 'a', ownedPaths: ['**/*.py'], registrations: [] },
      { key: 'b', ownedPaths: ['db/m/02_b_*'], registrations: [{ directory: 'db/m', prefix: '02_b_' }] },
    ])).toHaveLength(1)
  })
  it('refuses a file named outright under another package\'s prefix', () => {
    expect(registrationProblems([
      { key: 'a', ownedPaths: ['db/m/02_b_x.sql'], registrations: [] },
      { key: 'b', ownedPaths: ['db/m/02_b_*'], registrations: [{ directory: 'db/m', prefix: '02_b_' }] },
    ])).toHaveLength(1)
  })
  it('accepts a sibling directory, disjoint prefixes, and a literal file beside the directory', () => {
    expect(registrationProblems([
      { key: 'a', ownedPaths: ['db/seeds/**', 'db/m/01_a_*', 'db/m.md'], registrations: [{ directory: 'db/m', prefix: '01_a_' }] },
      { key: 'b', ownedPaths: ['db/m/02_b_*'], registrations: [{ directory: 'db/m', prefix: '02_b_' }] },
    ])).toEqual([])
  })
  it('names each package its own check file', () => {
    expect(verifyCheckPathFor('identity-access')).toBe('scripts/verify.d/identity-access.sh')
  })
})

describe('gateRunsVerifyScript (final review I1)', () => {
  it('is true only for a gate that runs scripts/verify.sh', () => {
    expect(gateRunsVerifyScript(['bash scripts/verify.sh'])).toBe(true)
    expect(gateRunsVerifyScript(['npm run lint', './scripts/verify.sh --all'])).toBe(true)
    expect(gateRunsVerifyScript(['/srv/repo/scripts/verify.sh'])).toBe(true)
    expect(gateRunsVerifyScript(['npm test'])).toBe(false)
    expect(gateRunsVerifyScript(['bash myscripts/verify.sh', 'bash scripts/verify.sh.bak'])).toBe(false)
    expect(gateRunsVerifyScript([])).toBe(false)
  })
})

describe('hasProductFiles (final review I3)', () => {
  it('sees no product in a new repository\'s first commit or repository furniture', () => {
    expect(hasProductFiles(['README.md', 'scripts/verify.sh', 'scripts/smoke.sh', ''])).toBe(false)
    expect(hasProductFiles(['README', 'LICENSE', '.gitignore', '.gitattributes', '.editorconfig', 'scripts/verify.d/skeleton.sh'])).toBe(false)
    expect(hasProductFiles([])).toBe(false)
  })
  it('sees a product in anything else', () => {
    expect(hasProductFiles(['README.md', 'src/main.ts'])).toBe(true)
    expect(hasProductFiles(['package.json'])).toBe(true)
    expect(hasProductFiles(['docs/README.md'])).toBe(true)
  })
})
