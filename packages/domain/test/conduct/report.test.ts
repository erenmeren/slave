import { describe, expect, it } from 'vitest'
import { hasSlaveReportBlock, parseSlaveReport } from '../../src/conduct/report.js'

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
})

describe('hasSlaveReportBlock', () => {
  it('is true only for a closed block, the last one counting', () => {
    expect(hasSlaveReportBlock('done\n<slave-report>{}</slave-report>')).toBe(true)
    expect(hasSlaveReportBlock('<slave-report>{} and then nothing')).toBe(false)
    expect(hasSlaveReportBlock('no report')).toBe(false)
    expect(hasSlaveReportBlock('<slave-report>{}</slave-report> then <slave-report>{')).toBe(false)
  })
})
