import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_CODE_MODELS, listClaudeCodeModels, listCursorModels, listProviderModels, parseCursorModels } from '../src/models.js'

const here = path.dirname(new URL(import.meta.url).pathname)
const fixture = readFileSync(path.join(here, 'fixtures', 'cursor', 'models.txt'), 'utf8')

describe('parseCursorModels', () => {
  it('strips ANSI, skips the heading and blank lines, splits "id - label", marks the default', () => {
    const models = parseCursorModels(fixture)
    expect(models[0]).toEqual({ id: 'auto', label: 'Auto', default: true })
    expect(models.some((m) => m.id === 'gpt-5.3-codex' && m.label === 'Codex 5.3')).toBe(true)
    expect(models.every((m) => !m.id.includes('\x1b') && !m.label.includes('\x1b'))).toBe(true)
    expect(models.every((m) => m.id !== '' && m.label !== '')).toBe(true)
  })

  it('returns an empty list for empty or unrelated output', () => {
    expect(parseCursorModels('')).toEqual([])
    expect(parseCursorModels('cursor-agent: unknown command\n')).toEqual([])
  })
})

describe('listClaudeCodeModels', () => {
  it('is the static table, source static, with the CLI aliases first and the default marked', () => {
    const listing = listClaudeCodeModels()
    expect(listing.source).toBe('static')
    expect(listing.error).toBeUndefined()
    expect(listing.models).toBe(CLAUDE_CODE_MODELS)
    expect(listing.models.slice(0, 5).map((m) => m.id)).toEqual(['default', 'fable', 'opus', 'sonnet', 'haiku'])
    expect(listing.models.filter((m) => m.default).map((m) => m.id)).toEqual(['default'])
  })
})

describe('listCursorModels', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function script(body: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-models-'))
    dirs.push(dir)
    const file = path.join(dir, 'fake-cursor-agent')
    writeFileSync(file, body)
    chmodSync(file, 0o755)
    return file
  }

  it('runs `<command> models` and parses its stdout as an account listing', async () => {
    const fixturePath = path.join(here, 'fixtures', 'cursor', 'models.txt')
    const command = script(`#!/bin/sh\n[ "$1" = "models" ] || exit 2\ncat "${fixturePath}"\n`)
    const listing = await listCursorModels(command)
    expect(listing.source).toBe('account')
    expect(listing.error).toBeUndefined()
    expect(listing.models[0]?.id).toBe('auto')
  })

  it('answers an error listing (empty models, source account) when the binary is missing or fails', async () => {
    const missing = await listCursorModels('/nonexistent/cursor-agent')
    expect(missing).toMatchObject({ models: [], source: 'account' })
    expect(missing.error).toBeTruthy()

    const failing = script('#!/bin/sh\necho "not logged in" >&2\nexit 1\n')
    const listing = await listCursorModels(failing)
    expect(listing).toMatchObject({ models: [], source: 'account' })
    expect(listing.error).toContain('not logged in')
  })
})

describe('listProviderModels', () => {
  it('dispatches on the kind', async () => {
    expect((await listProviderModels('claude_code')).source).toBe('static')
    expect((await listProviderModels('cursor', { cursorCommand: '/nonexistent/cursor-agent' })).error).toBeTruthy()
  })
})
