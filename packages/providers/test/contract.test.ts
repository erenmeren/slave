import { PROVIDER_KINDS, manifestFor, runId as brandRunId, type ProviderKind } from '@slave-of-ai/domain'
import { describe, expect, it } from 'vitest'
import { capabilitiesOf } from '../src/capabilities.js'
import { ClaudeCodeAdapter } from '../src/claude/adapter.js'
import { checkpointRunFiles, type RunFiles, type RunHandle } from '../src/contract/adapter.js'
import { CursorAdapter } from '../src/cursor/adapter.js'

/** A handle shaped exactly as an adapter reports one, with the channel names its manifest
 *  declares -- never hand-spelled keys, so a provider that renamed a channel fails here. */
function handleFor(kind: ProviderKind, paths: readonly [string, string]): RunHandle {
  const channels = manifestFor(kind).runFiles.channels
  const runFiles: Record<string, string> = {}
  channels.forEach((channel, index) => {
    runFiles[channel] = paths[index] ?? `/tmp/m56a-${channel}`
  })
  return { runId: brandRunId('11111111-1111-4111-8111-111111111111'), pid: 4242, runFiles }
}

describe('the contract is declared in one place (R1)', () => {
  it('re-exports every moved type from `claude/adapter.js`, so no import in the tree moved', async () => {
    // A runtime check of the MODULE's exports, because the five names are types and types are
    // erased: what this asserts is that the re-export line exists and resolves.
    const claude = await import('../src/claude/adapter.js')
    const contract = await import('../src/contract/adapter.js')
    expect(typeof contract.checkpointRunFiles).toBe('function')
    expect(claude).toHaveProperty('ClaudeCodeAdapter')
  })

  it('names each adapter by its KIND, in the enum’s spelling, not by an invented id', () => {
    const claude = new ClaudeCodeAdapter({ command: 'claude', hookPath: '/opt/slaveofai/pause-gate.sh' })
    const cursor = new CursorAdapter({ command: 'cursor-agent', gatePath: '/opt/slaveofai/cursor-shell-gate.sh' })
    // `'claude-code'` -- hyphenated, and NOT the `ProviderKind` -- is the wrinkle two comments in
    // this tree exist to warn about (`packages/control/src/index.ts:16-19`,
    // `apps/web/src/server/overview.ts:762-765`). It is gone.
    expect(claude.kind).toBe('claude_code')
    expect(cursor.kind).toBe('cursor')
    expect(PROVIDER_KINDS).toContain(claude.kind)
    expect(PROVIDER_KINDS).toContain(cursor.kind)
  })
})

describe('capabilitiesOf is a projection of the manifest (R4)', () => {
  it('answers the SAME OBJECT for a kind every time, which is what the adapter delegates to', () => {
    // Identity, not equality (`capabilities.test.ts:36-42`'s rule): a projection computed per call
    // would satisfy `toEqual` and break the one assertion that proves there is a single table.
    expect(capabilitiesOf('claude_code')).toBe(capabilitiesOf('claude_code'))
    const adapter = new ClaudeCodeAdapter({ command: 'claude', hookPath: '/opt/slaveofai/pause-gate.sh' })
    expect(adapter.getCapabilities()).toBe(capabilitiesOf('claude_code'))
  })

  it('derives each of the five members from the axis R4 names, for every provider', () => {
    for (const kind of PROVIDER_KINDS) {
      const manifest = manifestFor(kind)
      const capabilities = capabilitiesOf(kind)
      expect(capabilities.canPauseMidRun, kind).toBe(manifest.pause.rung === 'hook')
      expect(capabilities.canResumeSession, kind).toBe(manifest.resume.mode !== 'none')
      expect(capabilities.gate, kind).toBe(manifest.toolRestrictions.mechanism === 'none' ? 'none' : 'all-tools')
      expect(capabilities.reportsCost, kind).toBe(manifest.usageCost === 'reported')
      expect(capabilities.reportsToolResults, kind).toBe(manifest.events.produces.includes('tool_result'))
    }
  })

  it('never produces `shell-only`, which was superseded by proof and stays typed and unreachable', () => {
    for (const kind of PROVIDER_KINDS) expect(capabilitiesOf(kind).gate, kind).not.toBe('shell-only')
  })

  it('is frozen, so a consumer cannot edit the one table every other consumer reads', () => {
    expect(Object.isFrozen(capabilitiesOf('cursor'))).toBe(true)
  })
})

describe('runFiles is a record keyed by channel (R7)', () => {
  it('is what both adapters declare, and both declare exactly two', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(manifestFor(kind).runFiles.channels, kind).toEqual(['settings', 'hook'])
    }
  })

  it('maps the persisted pair onto the two Checkpoint columns, in the manifest’s order', () => {
    const handle = handleFor('claude_code', ['/run/settings.json', '/opt/pause-gate.sh'])
    expect(checkpointRunFiles('claude_code', handle)).toEqual({
      settingsPath: '/run/settings.json',
      hookPath: '/opt/pause-gate.sh',
    })
  })

  it('maps Cursor’s two files onto the same two columns, which is why no schema change was needed', () => {
    const handle = handleFor('cursor', ['/work/.cursor/hooks.json', '/opt/cursor-shell-gate.sh'])
    expect(checkpointRunFiles('cursor', handle)).toEqual({
      settingsPath: '/work/.cursor/hooks.json',
      hookPath: '/opt/cursor-shell-gate.sh',
    })
  })

  it('refuses a handle missing a persisted channel rather than writing an empty column', () => {
    // `Checkpoint.settingsPath` and `.hookPath` are NOT NULL. An adapter that reported one channel
    // would otherwise reach the database as an empty string and be discovered at resume time, three
    // hours later, as a settings file that does not exist.
    const broken: RunHandle = { ...handleFor('cursor', ['/a', '/b']), runFiles: { settings: '/a' } as RunFiles }
    expect(() => checkpointRunFiles('cursor', broken)).toThrow(/hook/)
  })
})
