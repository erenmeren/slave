import { describe, expect, it } from 'vitest'
import {
  parseSlaveVerification,
  renderVerificationGoal,
  renderVerificationProtocol,
  renderVerificationRework,
  trimEvidence,
} from '../../src/conduct/verification.js'

const block = (items: unknown): string => `done.\n<slave-verification>${JSON.stringify({ items })}</slave-verification>`
const pass = (key: string) => ({ key, status: 'pass', check: 'pytest -k csv', output: '1 passed', reason: '' })

describe('parseSlaveVerification', () => {
  it('reads one item per key', () => {
    const parsed = parseSlaveVerification(block([pass('R1'), { key: 'R2', status: 'fail', check: 'hsql --format json', output: 'Traceback', reason: 'prints CSV' }]), ['R1', 'R2'])
    expect(parsed.ok && parsed.value.map((i) => i.status)).toEqual(['pass', 'fail'])
  })

  it('reads the LAST block', () => {
    const text = `${block([{ ...pass('R1'), status: 'fail', reason: 'draft' }])}\n${block([pass('R1')])}`
    const parsed = parseSlaveVerification(text, ['R1'])
    expect(parsed.ok && parsed.value[0]?.status).toBe('pass')
  })

  it.each([
    ['no block', 'all good', /has no <slave-verification> block/],
    ['unclosed', '<slave-verification>{"items":[', /not closed/],
    ['bad json', '<slave-verification>{items}</slave-verification>', /not valid JSON/],
    ['a key twice', block([pass('R1'), pass('R1')]), /R1 is reported 2 times/],
    ['a key missing', block([pass('R1')]), /R2 is not reported/],
    ['an unknown key', block([pass('R1'), pass('R2'), pass('R9')]), /R9 is not a requirement of this goal/],
    ['fail with no reason', block([pass('R1'), { key: 'R2', status: 'fail', check: 'x', output: '', reason: '' }]), /R2 is fail with no reason/],
    ['pass with no check', block([pass('R1'), { key: 'R2', status: 'pass', check: '', output: '', reason: '' }]), /R2 is pass with no check/],
  ])('refuses %s', (_name, text, message) => {
    const parsed = parseSlaveVerification(text, ['R1', 'R2'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(message)
  })

  it('allows unverifiable with no check, and trims long output', () => {
    const parsed = parseSlaveVerification(
      block([{ key: 'R1', status: 'unverifiable', check: '', output: 'x'.repeat(10_000), reason: 'needs a network' }]),
      ['R1'],
    )
    expect(parsed.ok && parsed.value[0]?.output.length).toBeLessThan(4200)
    expect(parsed.ok && parsed.value[0]?.output).toContain('characters cut')
  })
})

describe('trimEvidence', () => {
  it('keeps short text and cuts the middle of long text', () => {
    expect(trimEvidence('abc', 10)).toBe('abc')
    const cut = trimEvidence(`HEAD${'m'.repeat(100)}TAIL`, 20)
    expect(cut.startsWith('HEAD')).toBe(true)
    expect(cut.endsWith('TAIL')).toBe(true)
  })
})

describe('rendering', () => {
  it('names the round, every key and the scratch directory', () => {
    const goal = renderVerificationGoal({
      goalVersion: 2,
      round: 3,
      requirements: [{ key: 'R1', text: 'csv', source: 'Add csv.' }, { key: 'R2', text: 'json', source: 'Add json.' }],
      diffStat: ' src/a.py | 3 +++',
      diffCapped: false,
    })
    expect(goal).toContain('Verification round 3 of goal v2')
    expect(goal).toContain('Requirement keys: R1, R2')
    const protocol = renderVerificationProtocol(['R1', 'R2'], '/state/runs/r1/verify')
    expect(protocol).toContain('$SLAVEOFAI_VERIFY_DIR (/state/runs/r1/verify)')
    expect(protocol).toContain('<slave-verification>')
  })

  it('bounds the rework reason and names each failing requirement', () => {
    const reason = renderVerificationRework(2, [
      { key: 'R2', text: 'json mode', status: 'fail', check: 'hsql --format json', output: 'y'.repeat(20_000), reason: 'prints CSV' },
    ])
    expect(reason).toContain('Verification round 2')
    expect(reason).toContain('R2: json mode')
    expect(reason.length).toBeLessThanOrEqual(6000)
  })
})
