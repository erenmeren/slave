import { describe, expect, it } from 'vitest'
import { hasSlaveReportBlock, leadFromReport, parseSlaveReport } from '../../src/conduct/report.js'

const wrap = (value: unknown): string => `Done.\n<slave-report>${JSON.stringify(value)}</slave-report>`
const good = {
  requirements: [{ key: 'R1', status: 'done', evidence: 'pytest -k csv passed' }, { key: 'R2', status: 'partial', evidence: 'json lacks nulls' }],
  filesTouched: ['src/report/csv.py'], workflow: [{ step: 1, done: true, note: '' }], questions: ['Should JSON nulls be omitted?'],
}

describe('parseSlaveReport', () => {
  it('reads a complete report', () => {
    const parsed = parseSlaveReport(wrap(good), ['R1', 'R2'])
    expect(parsed.ok && parsed.value.questions).toEqual(['Should JSON nulls be omitted?'])
  })

  it('drops the NUL byte and other control characters from every string, so the stored report is never refused (final review I2)', () => {
    const report = {
      ...good,
      requirements: [{ key: 'R1', status: 'done', evidence: 'ok\u0000' }, good.requirements[1]],
      questions: ['why\u0007?'],
      handOff: { path: 'skeleton/package.json\u0000', change: 'add a "start"\u0000 script\ud83d' },
    }
    const parsed = parseSlaveReport(wrap(report), ['R1', 'R2'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.requirements[0]?.evidence).toBe('ok')
    expect(parsed.value.questions).toEqual(['why?'])
    expect(parsed.value.handOff).toEqual({ path: 'skeleton/package.json', change: 'add a "start" script\ufffd' })
  })

  it('reads the LAST report when the message quotes an earlier one', () => {
    const text = `${wrap({ ...good, questions: ['old'] })}\n${wrap(good)}`
    const parsed = parseSlaveReport(text, ['R1', 'R2'])
    expect(parsed.ok && parsed.value.questions).toEqual(['Should JSON nulls be omitted?'])
  })

  it('names what is wrong', () => {
    expect(parseSlaveReport('Done, no report.', ['R1'])).toEqual({ ok: false, error: 'the final message has no <slave-report> block' })
    expect(parseSlaveReport('<slave-report>{"requirements": [', ['R1'])).toEqual({ ok: false, error: 'the <slave-report> block is not closed' })
    expect(parseSlaveReport('<slave-report>{nope}</slave-report>', ['R1'])).toEqual({ ok: false, error: 'the <slave-report> block is not valid JSON' })
    const missing = parseSlaveReport(wrap({ ...good, requirements: [good.requirements[0]] }), ['R1', 'R2'])
    expect(!missing.ok && missing.error).toContain('R2 is not reported')
    const twice = parseSlaveReport(wrap({ ...good, requirements: [good.requirements[0], good.requirements[0], good.requirements[1]] }), ['R1', 'R2'])
    expect(!twice.ok && twice.error).toContain('R1 is reported 2 times')
    const unknown = parseSlaveReport(wrap({ ...good, requirements: [...good.requirements, { key: 'R9', status: 'done', evidence: '' }] }), ['R1', 'R2'])
    expect(!unknown.ok && unknown.error).toContain('R9 is not one of yours')
  })

  it('defaults missing optional lists to empty', () => {
    const parsed = parseSlaveReport(wrap({ requirements: good.requirements }), ['R1', 'R2'])
    expect(parsed.ok && parsed.value).toEqual(expect.objectContaining({ filesTouched: [], workflow: [], questions: [] }))
  })

  it('reads an optional handOff, trimmed and bounded, and refuses an empty path', () => {
    const base = { requirements: [], filesTouched: [], workflow: [], questions: [] }
    const text = (value: object): string => `<slave-report>${JSON.stringify(value)}</slave-report>`
    const read = parseSlaveReport(text({ ...base, handOff: { path: ' backend/package.json ', change: 'add a "start" script' } }), [])
    expect(read.ok && read.value.handOff).toEqual({ path: 'backend/package.json', change: 'add a "start" script' })
    expect(parseSlaveReport(text(base), []).ok).toBe(true)
    expect(parseSlaveReport(text({ ...base, handOff: { path: '', change: 'x' } }), []).ok).toBe(false)
    expect(parseSlaveReport(text({ ...base, handOff: { path: 'a'.repeat(501), change: 'x' } }), []).ok).toBe(false)
    expect(parseSlaveReport(text({ ...base, handOff: { path: 'a', change: 'x'.repeat(2001) } }), []).ok).toBe(false)
    const noChange = parseSlaveReport(text({ ...base, handOff: { path: 'Dockerfile' } }), [])
    expect(noChange.ok && noChange.value.handOff).toEqual({ path: 'Dockerfile', change: '' })
  })
})

describe('hasSlaveReportBlock', () => {
  it('is true only for a closed block, the last one counting', () => {
    expect(hasSlaveReportBlock('done\n<slave-report>{}</slave-report>')).toBe(true)
    expect(hasSlaveReportBlock('<slave-report>{} and then nothing')).toBe(false)
    expect(hasSlaveReportBlock('no report')).toBe(false)
    expect(hasSlaveReportBlock('<slave-report>{}</slave-report> then <slave-report>{')).toBe(false)
  })

  it('is false when prose follows the closing tag, true when only whitespace does', () => {
    expect(hasSlaveReportBlock('<slave-report>{}</slave-report>\nNow let me also clean up the containers.')).toBe(false)
    expect(hasSlaveReportBlock('<slave-report>{}</slave-report>\n\n  \t\n')).toBe(true)
  })
})

describe('leadFromReport', () => {
  it('keeps questions, not-done requirements with their evidence, and workflow notes', () => {
    const lead = leadFromReport('integration', {
      requirements: [{ key: 'RUN', status: 'not_done', evidence: 'the image has no start script' }, { key: 'R1', status: 'done', evidence: 'ok' }],
      filesTouched: [],
      workflow: [{ step: 1, done: true, note: '' }, { step: 2, done: false, note: 'no frontend build stage' }],
      questions: ['Needs a person: the production Docker image cannot start'],
    })
    expect(lead).toEqual({
      packageKey: 'integration',
      lines: ['Needs a person: the production Docker image cannot start', 'RUN not done: the image has no start script', 'workflow step 2: no frontend build stage'],
    })
  })
  it('is null for a clean report or a row it cannot read', () => {
    expect(leadFromReport('a', { requirements: [{ key: 'R1', status: 'done', evidence: 'x' }], filesTouched: [], workflow: [], questions: [] })).toBeNull()
    expect(leadFromReport('a', 'not a report')).toBeNull()
  })

  it('reads handOffs (spec C1) and keeps reading a report without them (spec §4)', () => {
    const base = { requirements: [], filesTouched: [], workflow: [], questions: [] }
    const text = (value: object): string => `<slave-report>${JSON.stringify(value)}</slave-report>`
    const read = parseSlaveReport(text({ ...base, handOffs: [{ path: 'scripts/verify.sh', change: 'run pytest' }, { package: 'integration', change: 'expose GET /x' }] }), [])
    expect(read.ok && read.value.handOffs).toEqual([{ path: 'scripts/verify.sh', change: 'run pytest' }, { package: 'integration', change: 'expose GET /x' }])
    const old = parseSlaveReport(text(base), [])
    expect(old.ok && old.value.handOffs).toEqual([])
    expect(parseSlaveReport(text({ ...base, handOffs: Array.from({ length: 11 }, () => ({ package: 'a', change: 'x' })) }), []).ok).toBe(false)
    const both = parseSlaveReport(text({ ...base, handOffs: [{ path: 'a', package: 'b', change: 'x' }] }), [])
    expect(!both.ok && both.error).toContain('exactly one of "path" or "package"')
  })

  it('keeps the smoke handOff and the handOffs apart (plan A D12)', () => {
    const base = { requirements: [], filesTouched: [], workflow: [], questions: [] }
    const read = parseSlaveReport(`<slave-report>${JSON.stringify({ ...base, handOff: { path: 'Dockerfile', change: 'x' }, handOffs: [{ package: 'skeleton', change: 'y' }] })}</slave-report>`, [])
    expect(read.ok && read.value.handOff).toEqual({ path: 'Dockerfile', change: 'x' })
    expect(read.ok && read.value.handOffs).toEqual([{ package: 'skeleton', change: 'y' }])
  })

  it('strips a NUL from a hand-off change (F8)', () => {
    const base = { requirements: [], filesTouched: [], workflow: [], questions: [] }
    const read = parseSlaveReport(`<slave-report>${JSON.stringify({ ...base, handOffs: [{ path: 'a\u0000b', change: 'x\u0000y' }] })}</slave-report>`, [])
    expect(read.ok && read.value.handOffs).toEqual([{ path: 'ab', change: 'xy' }])
  })
})
