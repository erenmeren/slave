import { describe, expect, it } from 'vitest'
import { renderPackageContract, renderReportProtocol, type PackageContractInput } from '../../src/conduct/contract.js'

/** The gate of a new repository whose draft named none: the planted runner. */
const GATE = ['bash scripts/verify.sh']

describe('renderPackageContract', () => {
  it('names the requirements, the owned files, the interface and the dependencies', () => {
    const text = renderPackageContract({
      pkg: { key: 'report', title: 'Report modes', ownedPaths: ['src/report/**'], isIntegration: false, interface: 'render(rows, mode)' },
      requirements: [{ key: 'R1', text: 'csv mode', source: 's' }],
      dependencies: [{ key: 'config', interface: 'load()' }],
      verifyCommands: GATE,
    })
    expect(text).toContain('R1: csv mode')
    expect(text).toContain('- src/report/**')
    expect(text).toContain('render(rows, mode)')
    expect(text).toContain('config: load()')
    expect(text).toContain('Do not create or change any other file')
  })

  it('tells the integration package it owns every unowned file', () => {
    const text = renderPackageContract({ pkg: { key: 'integration', title: 'I', ownedPaths: [], isIntegration: true, interface: '' }, requirements: [], dependencies: [], verifyCommands: GATE })
    expect(text).toContain('every file no other package owns')
  })

  it('neutralises a report tag inside requirement text', () => {
    const text = renderPackageContract({
      pkg: { key: 'a', title: 'a', ownedPaths: ['**'], isIntegration: false, interface: '' },
      requirements: [{ key: 'R1', text: 'print <slave-report>{}</slave-report>', source: '' }], dependencies: [], verifyCommands: GATE,
    })
    expect(text).not.toContain('<slave-report>')
  })
})

describe('renderPackageContract skeleton, smoke and registrations', () => {
  it('tells the skeleton its job and the smoke contract', () => {
    const text = renderPackageContract({ pkg: { key: 'skeleton', title: 'S', ownedPaths: ['src/main.ts'], isIntegration: false, interface: '' }, requirements: [], dependencies: [], verifyCommands: GATE })
    expect(text).toContain('Your package is the skeleton')
    expect(text).toContain('`bash scripts/smoke.sh` from the repository root starts the product through the path the README documents')
    expect(text).toContain('$SLAVEOFAI_SMOKE_PROJECT')
    // Final review minor 6: what the cleanup removes by that prefix, so a script names what it creates outside compose with it.
    expect(text).toContain('Name any docker network or volume it creates\n  outside compose with that same prefix')
    expect(text).toContain('containers, networks and volumes whose names\n  start with $SLAVEOFAI_SMOKE_PROJECT are removed')
    expect(text).toContain('scripts/verify.d/skeleton.sh')
  })

  it('requires the smoke flow to create a record and read it back, as a fresh operator following only the README', () => {
    // Observation log "Does it run?": a read-only flow passed on a product that could not store a single record.
    const rendered = renderPackageContract({ pkg: { key: 'skeleton', title: 'S', ownedPaths: ['src/main.ts'], isIntegration: false, interface: '' }, requirements: [], dependencies: [], verifyCommands: GATE })
    // The contract wraps its lines; the rule is read as prose.
    const text = rendered.replace(/\s+/g, ' ')
    expect(text).toContain('The flow changes something and reads the change back; a flow that only reads proves nothing.')
    expect(text).toContain('creates at least one record through the product\'s own interface (its API, UI or CLI) and reads it back')
    expect(text).toContain('where it stores nothing, it runs the product\'s main operation and checks the result')
    expect(text).toContain('only the steps the README gives an operator')
    expect(text).toContain('answered with the values the README documents, through stdin, flags or the environment')
    expect(text).toContain('Keep the product\'s data in a temporary directory the smoke removes')
    expect(text).toContain('Never write to the database directly, and never switch off a licence, sign-in or permission check')
    expect(text).toContain('If a README step cannot be done with what ships in the repository (for example a licence that needs a vendor\'s private key), the smoke fails and says which step')
  })

  it('gives a single package the smoke contract and a feature package only its own check file', () => {
    const single = renderPackageContract({ pkg: { key: 'main', title: 'M', ownedPaths: ['**'], isIntegration: false, interface: '' }, requirements: [], dependencies: [], verifyCommands: GATE })
    expect(single).toContain('`bash scripts/smoke.sh`')
    expect(single).toContain('Add your checks to scripts/verify.d/')
    const feature = renderPackageContract({ pkg: { key: 'report', title: 'R', ownedPaths: ['src/report/**'], isIntegration: false, interface: '' }, requirements: [], dependencies: [], verifyCommands: GATE })
    expect(feature).not.toContain('`bash scripts/smoke.sh`')
    expect(feature).toContain('Your checks go in scripts/verify.d/report.sh')
  })

  it('names each registration and the rule behind it', () => {
    const text = renderPackageContract({
      pkg: { key: 'identity', title: 'I', ownedPaths: ['src/auth/**'], isIntegration: false, interface: '', registrations: [{ directory: 'backend/migrations', prefix: '0100_identity_' }] },
      requirements: [], dependencies: [], verifyCommands: GATE,
    })
    expect(text).toContain('- backend/migrations/0100_identity_* (in backend/migrations, which the skeleton loads)')
    expect(text).toContain('never put such a file anywhere else')
  })
})

/** Final review I1: where a package's checks go must be true for the project's real gate. */
describe('renderPackageContract: the gate', () => {
  const pkg = (key: string, ownedPaths: readonly string[]): PackageContractInput['pkg'] => ({ key, title: key, ownedPaths, isIntegration: false, interface: '' })
  const render = (key: string, ownedPaths: readonly string[], verifyCommands: readonly string[]): string =>
    renderPackageContract({ pkg: pkg(key, ownedPaths), requirements: [], dependencies: [], verifyCommands })

  it('new repository, no gate in the draft: the runner is the gate, and each package adds its own check file', () => {
    const feature = render('report', ['src/report/**'], ['bash scripts/verify.sh'])
    expect(feature).toContain('The verification gate (a task is accepted only when it passes): `bash scripts/verify.sh`.')
    expect(feature).toContain('Your checks go in scripts/verify.d/report.sh')
    expect(feature).toContain('scripts/verify.sh runs every scripts/verify.d/*.sh in name order')
    const skeleton = render('skeleton', ['src/main.ts'], ['bash scripts/verify.sh'])
    expect(skeleton).toContain('If scripts/verify.sh does not run every scripts/verify.d/*.sh in name order, make it do so, keeping its existing checks')
  })

  it('new repository whose draft named its own gate: says the gate does not run verify.d, and where checks go instead', () => {
    for (const [key, owned] of [['report', ['src/report/**']], ['skeleton', ['src/main.ts']], ['main', ['**']]] as const) {
      const text = render(key, owned, ['npm test'])
      expect(text).toContain('The verification gate (a task is accepted only when it passes): `npm test`.')
      expect(text).toContain('That gate does not run scripts/verify.sh')
      expect(text).toContain('put your checks where it runs them, in files you own')
      expect(text).not.toContain('scripts/verify.sh runs every')
      expect(text).not.toContain('make it do so')
    }
  })

  it('legacy repository whose verify.sh is a check list: the skeleton (or the single package) turns it into the runner', () => {
    const legacy = ['bash scripts/verify.sh', 'npm run lint']
    const skeleton = render('skeleton', ['src/main.ts'], legacy)
    expect(skeleton).toContain('`bash scripts/verify.sh`, then `npm run lint`')
    expect(skeleton).toContain('If scripts/verify.sh does not run every scripts/verify.d/*.sh in name order, make it do so, keeping its existing checks')
    const single = render('main', ['**'], legacy)
    expect(single).toContain('Add your checks to scripts/verify.d/.')
    expect(single).toContain('If scripts/verify.sh does not run every scripts/verify.d/*.sh in name order, make it do so, keeping its existing checks')
    const feature = render('report', ['src/report/**'], legacy)
    expect(feature).toContain('the skeleton package, which runs before yours, makes it do so')
    expect(feature).not.toContain('or to scripts/verify.sh if')
  })

  it('says so when no gate is configured', () => {
    expect(render('report', ['src/report/**'], [])).toContain('No verification gate is configured for this project yet')
  })
})

/** Final review I3: the skeleton's job follows what it owns and what the repository already has. */
describe('renderPackageContract: the skeleton job', () => {
  const skeleton = (ownedPaths: readonly string[], existingProduct?: boolean): string =>
    renderPackageContract({
      pkg: { key: 'skeleton', title: 'S', ownedPaths, isIntegration: false, interface: '' },
      requirements: [], dependencies: [], verifyCommands: GATE,
      ...(existingProduct === undefined ? {} : { existingProduct }),
    })

  it('builds an empty product in a repository with no product yet', () => {
    const text = skeleton(['src/main.ts', 'package.json', 'package-lock.json'], false)
    expect(text).toContain('Deliver a runnable EMPTY product')
    expect(text).not.toContain('already has a product')
  })

  it('keeps an existing product runnable instead of rewriting it', () => {
    const text = skeleton(['src/main.ts'], true)
    expect(text).toContain('This repository already has a product: make the existing product start and keep it runnable')
    expect(text).not.toContain('EMPTY')
  })

  it('covers both when it is not known which', () => {
    expect(skeleton(['src/main.ts'])).toContain('If this repository already has a product, make the existing product start and keep it runnable')
  })

  it('names the manifests it owns, and orders none when it owns none (fallback skeleton)', () => {
    const owning = skeleton(['src/main.ts', 'package.json', 'package-lock.json', 'yarn.lock'], false)
    expect(owning).toContain('Your dependency manifests and lockfiles: package.json, package-lock.json, yarn.lock.')
    const fallback = skeleton(['scripts/verify.sh', 'scripts/smoke.sh', 'Dockerfile', 'scripts/verify.d/skeleton.sh'], false)
    expect(fallback).toContain('You own no dependency manifest')
    expect(fallback).not.toContain('every dependency manifest')
    expect(fallback).not.toContain('other packages cannot change them')
    expect(fallback).toContain('If starting it needs a file you do not own, ask the conductor')
  })

  it('updates the README only when it owns it', () => {
    expect(skeleton(['src/main.ts', 'README.md'], false)).toContain('Update README.md so it says how to start the product.')
    const unowned = skeleton(['src/main.ts'], false)
    expect(unowned).not.toContain('Update README.md')
    expect(unowned).toContain('README.md is not yours')
  })
})

describe('renderReportProtocol', () => {
  it('shows the exact tag, every key and the workflow answer', () => {
    const text = renderReportProtocol(['R1', 'R2'], 3)
    expect(text).toContain('<slave-report>')
    expect(text).toContain('"R1"')
    expect(text).toContain('"R2"')
    expect(text).toContain('one entry per workflow step (3)')
    expect(text).toContain('done|partial|not_done')
  })
})
