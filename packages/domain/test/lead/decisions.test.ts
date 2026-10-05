import { describe, expect, it } from 'vitest'
import { LEAD_DECISIONS_READ_MAX, parseLeadDecisions } from '../../src/lead/index.js'

describe('parseLeadDecisions (lead-flow spec B9)', () => {
  it('reads one decision per "## " heading, with everything under it as its text', () => {
    const file = ['# Decisions', '', 'Recorded while building.', '', '## Database', 'SQLite, one file.', '', 'Reason: no server to run.', '', '### Detail', 'WAL mode.', '', '## Port  ', '8080, as the README says.'].join('\n')
    expect(parseLeadDecisions(file)).toEqual([
      { title: 'Database', decision: 'SQLite, one file.\n\nReason: no server to run.\n\n### Detail\nWAL mode.' },
      { title: 'Port', decision: '8080, as the README says.' },
    ])
  })

  it('skips a heading with nothing under it, and reads nothing from a file with no such heading', () => {
    expect(parseLeadDecisions('## Empty\n\n## Kept\nyes')).toEqual([{ title: 'Kept', decision: 'yes' }])
    expect(parseLeadDecisions('we decided things\n')).toEqual([])
    expect(parseLeadDecisions('')).toEqual([])
  })

  it('reads at most the bound, and reads CRLF files', () => {
    const many = Array.from({ length: LEAD_DECISIONS_READ_MAX + 5 }, (_, i) => `## D${String(i)}\r\ntext ${String(i)}\r\n`).join('')
    const read = parseLeadDecisions(many)
    expect(read).toHaveLength(LEAD_DECISIONS_READ_MAX)
    expect(read[0]).toEqual({ title: 'D0', decision: 'text 0' })
  })
})
