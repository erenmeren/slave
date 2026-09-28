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
