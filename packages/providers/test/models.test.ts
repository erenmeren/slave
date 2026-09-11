import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MODEL_PRICES, PRICE_ALIASES, estimateCostUsd } from '@slave-of-ai/domain'
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

/**
 * The pin the T1 review asked for (M51 R5). `MODEL_PRICES` lives in `@slave-of-ai/domain` and
 * `CLAUDE_CODE_MODELS` lives here, and nothing structural connects them: a model added to the
 * roster with no row in the price table estimates `null` for every run that picks it, silently, and
 * the brief's cost tile just shows one fewer figure. This test is the connection.
 *
 * A TEST-ONLY import of the domain, which is the one direction this package allows: `packages/
 * providers` must not import `@slave-of-ai/db` at runtime and takes nothing from the domain's new
 * modules in `src/` -- the parsers produce evidence and the domain judges it. Reading the domain's
 * price table from a test asserts an agreement between two lists without creating a dependency
 * between two modules.
 */
describe('every listed Claude model is priced (M51 R5)', () => {
  it('has a MODEL_PRICES row for every CLAUDE_CODE_MODELS id but `default`', () => {
    const unpriced = CLAUDE_CODE_MODELS.map((model) => model.id)
      // `default` is deliberately unpriced: which model the CLI picks with no `--model` is the
      // CLI's own current choice and is not knowable from inside this repository, so a confident
      // guess here would put a wrong price on the majority of runs. See `PRICE_ALIASES`'s docstring.
      .filter((id) => id !== 'default')
      .filter((id) => estimateCostUsd(id, { input: 1_000_000, output: 1_000_000 }) === null)
    expect(unpriced).toEqual([])
  })

  it('prices the aliases as the full ids they name, not as separate models', () => {
    const million = { input: 1_000_000, output: 1_000_000 }
    for (const [alias, full] of Object.entries(PRICE_ALIASES)) {
      expect(estimateCostUsd(alias, million), alias).toBe(estimateCostUsd(full, million))
    }
  })

  it('names no price for a model the roster does not offer', () => {
    // The reverse direction, and it is a warning rather than a rule: a price for a retired model
    // is harmless (old runs still carry its id on `SlaveRun.model`), so this asserts only that
    // every PRICED id is either on the roster or reachable through an alias -- a price for a model
    // nobody could ever have run is a typo.
    const offered = new Set<string>(CLAUDE_CODE_MODELS.map((model) => model.id))
    for (const alias of Object.values(PRICE_ALIASES)) offered.add(alias)
    for (const id of Object.keys(MODEL_PRICES)) expect(offered, id).toContain(id)
  })
})
