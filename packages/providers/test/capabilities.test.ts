import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter } from '../src/index.js'

describe('ProviderCapabilities', () => {
  it('exposes exactly the four members the system consumes', () => {
    const caps = new ClaudeCodeAdapter({ command: 'claude' }).getCapabilities()
    expect(Object.keys(caps).sort()).toEqual([
      'canPauseMidRun',
      'canResumeSession',
      'gate',
      'reportsCost',
    ])
  })

  it('describes the Claude runtime: mid-run pause, resumable, gates every tool, reports cost', () => {
    const caps = new ClaudeCodeAdapter({ command: 'claude' }).getCapabilities()
    expect(caps).toEqual({
      canPauseMidRun: true,
      canResumeSession: true,
      gate: 'all-tools',
      reportsCost: true,
    })
  })
})
