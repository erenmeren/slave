import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSettings, writeSettingsFile } from '../src/claude/settings.js'

describe('buildSettings', () => {
  it('registers the given absolute hook path as a PreToolUse hook matching every tool', () => {
    const settings = buildSettings({ hookPath: '/abs/pause-gate.sh' })
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: '/abs/pause-gate.sh' }],
          },
        ],
      },
    })
  })

  it('refuses a relative hook path', () => {
    expect(() => buildSettings({ hookPath: 'rel/pause-gate.sh' })).toThrow(/absolute/)
  })
})

describe('writeSettingsFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-settings-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a settings file the CLI can parse as JSON, matching buildSettings', () => {
    const settingsPath = path.join(dir, 'settings.json')
    const hookPath = path.join(dir, 'pause-gate.sh')

    writeSettingsFile({ settingsPath, hookPath })

    expect(existsSync(settingsPath)).toBe(true)
    const written: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(written).toEqual(buildSettings({ hookPath }))
  })

  it('refuses a relative settings path', () => {
    expect(() => writeSettingsFile({ settingsPath: 'rel/settings.json', hookPath: '/abs/pause-gate.sh' })).toThrow(
      /absolute/,
    )
  })
})
