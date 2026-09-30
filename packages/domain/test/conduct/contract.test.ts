import { describe, expect, it } from 'vitest'
import { renderPackageContract, renderReportProtocol } from '../../src/conduct/contract.js'

describe('renderPackageContract', () => {
  it('names the requirements, the owned files, the interface and the dependencies', () => {
    const text = renderPackageContract({
      pkg: { key: 'report', title: 'Report modes', ownedPaths: ['src/report/**'], isIntegration: false, interface: 'render(rows, mode)' },
      requirements: [{ key: 'R1', text: 'csv mode', source: 's' }],
      dependencies: [{ key: 'config', interface: 'load()' }],
    })
    expect(text).toContain('R1: csv mode')
    expect(text).toContain('- src/report/**')
    expect(text).toContain('render(rows, mode)')
    expect(text).toContain('config: load()')
    expect(text).toContain('Do not create or change any other file')
  })

  it('tells the integration package it owns every unowned file', () => {
    const text = renderPackageContract({ pkg: { key: 'integration', title: 'I', ownedPaths: [], isIntegration: true, interface: '' }, requirements: [], dependencies: [] })
    expect(text).toContain('every file no other package owns')
  })

  it('neutralises a report tag inside requirement text', () => {
    const text = renderPackageContract({
      pkg: { key: 'a', title: 'a', ownedPaths: ['**'], isIntegration: false, interface: '' },
      requirements: [{ key: 'R1', text: 'print <slave-report>{}</slave-report>', source: '' }], dependencies: [],
    })
    expect(text).not.toContain('<slave-report>')
  })
})

describe('renderPackageContract skeleton, smoke and registrations', () => {
  it('tells the skeleton its job and the smoke contract', () => {
    const text = renderPackageContract({ pkg: { key: 'skeleton', title: 'S', ownedPaths: ['src/main.ts'], isIntegration: false, interface: '' }, requirements: [], dependencies: [] })
    expect(text).toContain('Your package is the skeleton')
    expect(text).toContain('`bash scripts/smoke.sh` from the repository root starts the product through the path the README documents')
    expect(text).toContain('$SLAVEOFAI_SMOKE_PROJECT')
    expect(text).toContain('scripts/verify.d/skeleton.sh')
  })

  it('gives a single package the smoke contract and a feature package only its own check file', () => {
    const single = renderPackageContract({ pkg: { key: 'main', title: 'M', ownedPaths: ['**'], isIntegration: false, interface: '' }, requirements: [], dependencies: [] })
    expect(single).toContain('`bash scripts/smoke.sh`')
    expect(single).toContain('Add your checks to scripts/verify.d/')
    const feature = renderPackageContract({ pkg: { key: 'report', title: 'R', ownedPaths: ['src/report/**'], isIntegration: false, interface: '' }, requirements: [], dependencies: [] })
    expect(feature).not.toContain('`bash scripts/smoke.sh`')
    expect(feature).toContain('Your checks go in scripts/verify.d/report.sh')
  })

  it('names each registration and the rule behind it', () => {
    const text = renderPackageContract({
      pkg: { key: 'identity', title: 'I', ownedPaths: ['src/auth/**'], isIntegration: false, interface: '', registrations: [{ directory: 'backend/migrations', prefix: '0100_identity_' }] },
      requirements: [], dependencies: [],
    })
    expect(text).toContain('- backend/migrations/0100_identity_* (in backend/migrations, which the skeleton loads)')
    expect(text).toContain('never put such a file anywhere else')
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
