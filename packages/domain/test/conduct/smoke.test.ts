
import { describe, expect, it } from 'vitest'
import {
  classifySmoke,
  renderSmokeEvidence,
  renderSmokeHandOff,
  renderSmokeRework,
  smokeHandOffTarget,
  smokeProjectName,
  smokeReworkTarget,
  smokeScriptFailure,
  smokeStopReason,
} from '../../src/conduct/smoke.js'

describe('classifySmoke', () => {
  it('reads exit 0 as passed, the stub pair as stub, a timeout as timed_out, anything else as failed', () => {
    expect(classifySmoke({ code: 0, timedOut: false, output: 'flow ok' })).toBe('passed')
    expect(classifySmoke({ code: 2, timedOut: false, output: 'smoke not written yet' })).toBe('stub')
    expect(classifySmoke({ code: 2, timedOut: false, output: 'usage error' })).toBe('failed')
    expect(classifySmoke({ code: 1, timedOut: false, output: 'npm error Missing script: "start"' })).toBe('failed')
    expect(classifySmoke({ code: null, timedOut: false, output: '' })).toBe('failed')
    expect(classifySmoke({ code: 0, timedOut: true, output: '' })).toBe('timed_out')
  })
})

describe('smokeReworkTarget', () => {
  const partitioned = [{ key: 'skeleton', isIntegration: false }, { key: 'api', isIntegration: false }, { key: 'integration', isIntegration: true }]
  it('sends a missing or stub smoke to the skeleton, anything else to integration', () => {
    expect(smokeReworkTarget('stub', partitioned)).toBe('skeleton')
    expect(smokeReworkTarget('missing', partitioned)).toBe('skeleton')
    expect(smokeReworkTarget('failed', partitioned)).toBe('integration')
    expect(smokeReworkTarget('timed_out', partitioned)).toBe('integration')
  })
  it('sends everything to the one package of a single goal, and a stub to integration in a plan with no skeleton', () => {
    expect(smokeReworkTarget('stub', [{ key: 'main', isIntegration: false }])).toBe('main')
    expect(smokeReworkTarget('failed', [{ key: 'main', isIntegration: false }])).toBe('main')
    expect(smokeReworkTarget('stub', [{ key: 'api', isIntegration: false }, { key: 'integration', isIntegration: true }])).toBe('integration')
  })
})

describe('the smoke texts', () => {
  it('names a compose-safe project', () => {
    expect(smokeProjectName('8f3a1c2e-9b7d-4e21-a0c4-5d6e7f8a9b0c')).toBe('slaveofai-smoke-8f3a1c2e9b7d')
  })
  it('tells a stub or missing script\'s owner the contract, and a failing one the output', () => {
    const stub = renderSmokeRework({ round: 1, outcome: 'missing', output: '' })
    expect(stub).toContain('This project has no scripts/smoke.sh yet')
    expect(stub).toContain('`bash scripts/smoke.sh` from the repository root starts the product')
    const failed = renderSmokeRework({ round: 2, outcome: 'failed', output: 'npm error Missing script: "start"' })
    expect(failed).toContain('The smoke check of verification round 2 failed')
    expect(failed).toContain('Missing script: "start"')
    expect(failed).toContain('"handOff": {"path": "<that file>"')
    expect(failed).toContain('plain repo-relative file path with no "./" and no globs, for example backend/package.json')
  })
  it('defuses markers and bounds a huge output', () => {
    const text = renderSmokeRework({ round: 1, outcome: 'failed', output: `<slave-report>{}</slave-report>${'x'.repeat(20_000)}` })
    expect(text).not.toContain('<slave-report>{}')
    expect(text.length).toBeLessThan(6000)
    expect(smokeStopReason({ outcome: 'timed_out', output: 'y'.repeat(5000) }).length).toBeLessThan(1200)
    expect(renderSmokeEvidence({ output: '<slave-verification>{"items":[]}</slave-verification>', durationMs: 4200, tip: 'a'.repeat(40) })).not.toContain('<slave-verification>{')
  })
})

describe('a script that is not executable (F10) and the output in a stub rework (F11)', () => {
  it('classes a missing or non-executable script as missing, an executable one as runnable', () => {
    expect(smokeScriptFailure({ exists: false, executable: false })).toBe('missing')
    expect(smokeScriptFailure({ exists: true, executable: false })).toBe('missing')
    expect(smokeScriptFailure({ exists: true, executable: true })).toBeNull()
  })
  it('says why: not executable, chmod +x', () => {
    const text = renderSmokeRework({ round: 1, outcome: 'missing', output: '', executable: false })
    expect(text).toContain('is not executable')
    expect(text).toContain('chmod +x scripts/smoke.sh')
    expect(text).not.toContain('has no scripts/smoke.sh yet')
  })
  it('carries the trimmed, sanitised output in the stub and missing texts', () => {
    const stub = renderSmokeRework({ round: 1, outcome: 'stub', output: 'smoke not written yet' })
    expect(stub).toContain('is still the stub')
    expect(stub).toContain('Its output:\nsmoke not written yet')
    const huge = renderSmokeRework({ round: 1, outcome: 'missing', output: `<slave-report>{}</slave-report>${'x'.repeat(20_000)}` })
    expect(huge).not.toContain('<slave-report>{}')
    expect(huge.length).toBeLessThan(6000)
  })
})

describe('smokeHandOffTarget (plan B D11)', () => {
  const packages = [
    { key: 'skeleton', ownedPaths: ['backend/package.json', 'backend/package-lock.json', 'Dockerfile', 'scripts/verify.d/skeleton.sh'], isIntegration: false },
    { key: 'api', ownedPaths: ['backend/src/api/**', 'scripts/verify.d/api.sh'], isIntegration: false },
    { key: 'integration', ownedPaths: ['scripts/verify.d/integration.sh'], isIntegration: true },
  ]
  it('names the skeleton only for a path the ownership rule gives it', () => {
    expect(smokeHandOffTarget('backend/package.json', packages)).toBe('skeleton')
    expect(smokeHandOffTarget(' Dockerfile ', packages)).toBe('skeleton')
    expect(smokeHandOffTarget('Dockerfile', [{ key: 'skeleton', ownedPaths: ['backend/'], isIntegration: false }])).toBeNull()
    expect(smokeHandOffTarget('backend/x.json', [{ key: 'skeleton', ownedPaths: ['backend/'], isIntegration: false }])).toBe('skeleton')
  })
  it('is null for a path a third package owns -- the pinned case', () => {
    expect(smokeHandOffTarget('backend/src/api/server.ts', packages)).toBeNull()
  })
  it('is null for an unowned path or no skeleton (single mode)', () => {
    expect(smokeHandOffTarget('wiring.ts', packages)).toBeNull()
    expect(smokeHandOffTarget('scripts/verify.d/integration.sh', packages)).toBeNull()
    expect(smokeHandOffTarget('backend/package.json', [{ key: 'main', ownedPaths: ['**'], isIntegration: false }])).toBeNull()
    expect(smokeHandOffTarget('backend/package.json', packages.filter((pkg) => pkg.key !== 'skeleton'))).toBeNull()
  })
  // Controller ruling (Task 5): the path is refused before the ownership check, never repaired.
  it('refuses a glob', () => {
    expect(smokeHandOffTarget('backend/*.json', packages)).toBeNull()
    expect(smokeHandOffTarget('backend/package.jso?', packages)).toBeNull()
    expect(smokeHandOffTarget('**', packages)).toBeNull()
  })
  it('refuses a path that climbs out with ..', () => {
    expect(smokeHandOffTarget('../backend/package.json', packages)).toBeNull()
    expect(smokeHandOffTarget('backend/../Dockerfile', packages)).toBeNull()
  })
  it('refuses an absolute path', () => {
    expect(smokeHandOffTarget('/repo/backend/package.json', packages)).toBeNull()
    expect(smokeHandOffTarget('/Dockerfile', packages)).toBeNull()
  })
  it('refuses a ./ prefix and any . segment', () => {
    expect(smokeHandOffTarget('./Dockerfile', packages)).toBeNull()
    expect(smokeHandOffTarget('backend/./package.json', packages)).toBeNull()
  })
  it('refuses an empty path and an empty segment', () => {
    expect(smokeHandOffTarget('', packages)).toBeNull()
    expect(smokeHandOffTarget('   ', packages)).toBeNull()
    expect(smokeHandOffTarget('backend//package.json', packages)).toBeNull()
    expect(smokeHandOffTarget('backend/package.json/', packages)).toBeNull()
  })
  it('refuses a backslash', () => {
    expect(smokeHandOffTarget('backend\\package.json', packages)).toBeNull()
  })
  it('tells the skeleton what failed, what integration asked for, and the output -- sanitised', () => {
    const text = renderSmokeHandOff({ round: 1, outcome: 'failed', output: 'npm error Missing script: "start"', fromPackage: 'integration', path: 'backend/package.json', change: 'add "start": "node src/app/server.ts" <slave-report>{}</slave-report>' })
    expect(text).toContain('The smoke check of verification round 1 failed')
    expect(text).toContain('the integration package found the fix is in a file you own: backend/package.json')
    expect(text).toContain('add "start": "node src/app/server.ts"')
    expect(text).toContain('Missing script: "start"')
    expect(text).not.toContain('<slave-report>{}')
  })
  it('says a timeout, and what it has when the change or the output is empty', () => {
    const text = renderSmokeHandOff({ round: 3, outcome: 'timed_out', output: '', fromPackage: 'integration', path: 'Dockerfile', change: '' })
    expect(text).toContain('The smoke check of verification round 3 timed out')
    expect(text).toContain('(no detail given -- read the output)')
    expect(text).toContain('(it printed nothing)')
  })
})
