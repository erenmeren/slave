import { describe, expect, it } from 'vitest'
import { evidenceAnchor, evidenceCut, formatReportUsd, mdFence, mdInline, mdQuote, shortCommit } from '../../src/goalReport/escape.js'

describe('the report\'s escapes', () => {
  it('mdInline collapses whitespace, escapes HTML and Markdown punctuation, and neutralises markers', () => {
    expect(mdInline('a\n  b')).toBe('a b')
    expect(mdInline('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
    expect(mdInline('*x* _y_ `z` [l](u) |')).toBe('\\*x\\* \\_y\\_ \\`z\\` \\[l\\]\\(u\\) \\|')
    expect(mdInline('<slave-report>')).toBe('‹slave-report&gt;')
  })

  it('mdFence picks a fence longer than any backtick run and drops trailing newlines', () => {
    expect(mdFence('plain\n\n')).toBe('```text\nplain\n```')
    expect(mdFence('a ```` b')).toBe('`````text\na ```` b\n`````')
  })

  it('mdQuote quotes every line and keeps blank ones', () => {
    expect(mdQuote('one\n\ntwo')).toEqual(['> one', '>', '> two'])
  })

  it('mdInline breaks a bare URL\'s GFM autolink by escaping its ://', () => {
    expect(mdInline('see http://evil.example/x')).toBe('see http\\://evil.example/x')
    expect(mdInline('javascript://alert(1)')).toBe('javascript\\://alert\\(1\\)')
  })

  it('mdQuote escapes a line that would open a new block once it follows "> "', () => {
    expect(mdQuote('first\n===')).toEqual(['> first', '> \\==='])
    expect(mdQuote('a\n---')).toEqual(['> a', '> \\---'])
    expect(mdQuote('- x')).toEqual(['> \\- x'])
    expect(mdQuote('+ x')).toEqual(['> \\+ x'])
    expect(mdQuote('1. y')).toEqual(['> 1\\. y'])
    expect(mdQuote('plain text')).toEqual(['> plain text'])
  })

  it('reads the cut marker trimEvidence writes, and formats money and commits', () => {
    expect(evidenceCut('head\n… [42 characters cut] …\ntail')).toBe(42)
    expect(evidenceCut('whole')).toBe(0)
    expect(evidenceAnchor('R12')).toBe('evidence-for-r12')
    expect(formatReportUsd(null)).toBe('—')
    expect(formatReportUsd(0.001)).toBe('<$0.01')
    expect(formatReportUsd(4.125)).toBe('$4.13')
    expect(shortCommit(null)).toBe('unknown')
    expect(shortCommit('a'.repeat(40))).toBe('a'.repeat(12))
  })
})
