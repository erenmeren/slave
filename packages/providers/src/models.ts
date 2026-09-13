import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CLAUDE_CODE_MANIFEST, manifestFor, type ModelOption } from '@slave-of-ai/domain'
import type { ProviderKind } from './types.js'

const run = promisify(execFile)

/**
 * One entry of a provider's model list. MOVED to `@slave-of-ai/domain` (M56a erratum E2) because a
 * `configured` provider's manifest holds its own model table and the domain cannot import this
 * package; re-exported here so `ModelListing` and every caller keep the path they have.
 */
export type { ModelOption } from '@slave-of-ai/domain'

/**
 * A provider's selectable models (M25 §5.1). `account` means the list was read from the
 * provider for THIS login (Cursor: `cursor-agent models`); `static` means it is the adapter's own
 * table (Claude Code, whose CLI documents aliases but lists nothing). An `account` read that
 * failed comes back with `error` set and `models` empty -- never a throw -- so a form can fall
 * back to free text and say why.
 */
export interface ModelListing {
  readonly models: readonly ModelOption[]
  readonly source: 'account' | 'static'
  readonly error?: string
}

// `\x1b[36m` / `\x1b[2m` / `\x1b[22m` / `\x1b[39m` -- the colour and dim toggles `cursor-agent
// models` wraps every token in, even when stdout is not a TTY.
const ANSI = /\x1b\[[0-9;]*m/g

/**
 * `cursor-agent models` prints a heading, a blank line, then one `<id> - <label>` per line; the
 * account's default carries a trailing ` (default)`. Pure: the captured output in
 * `test/fixtures/cursor/models.txt` is the contract. Anything that is not an `id - label` line is
 * skipped, so a version that adds prose keeps parsing.
 */
export function parseCursorModels(stdout: string): readonly ModelOption[] {
  const models: ModelOption[] = []
  for (const raw of stdout.replace(ANSI, '').split('\n')) {
    const line = raw.trim()
    const separator = line.indexOf(' - ')
    if (line === '' || separator <= 0) continue
    const id = line.slice(0, separator).trim()
    let label = line.slice(separator + 3).trim()
    let isDefault = false
    if (label.endsWith('(default)')) {
      isDefault = true
      label = label.slice(0, -'(default)'.length).trim()
    }
    if (id === '' || label === '' || id.includes(' ')) continue
    models.push(isDefault ? { id, label, default: true } : { id, label })
  }
  return models
}

/**
 * How a `listed` provider's stdout is read back, by kind (M56a R6).
 *
 * `Partial<Record<…>>` rather than a `Record`: a `configured` provider has no stdout to parse at
 * all, and the correspondence between this table's keys and `modelDiscovery.mode === 'listed'` is
 * asserted against the manifests in `test/registry.test.ts` rather than left to a reader.
 * `PROVIDER_ADAPTERS` hands out these SAME function objects, and the same test pins that too, so a
 * provider cannot be registered with one parser and read with another.
 *
 * DECLARED HERE AND NOT IN `registry.ts`, which is where the registration lives (M56a task 3,
 * ruling P12a). `listProviderModels` below needs it, and `registry.ts` imports both adapters, each
 * of which imports THIS module for its own `listModels()` -- so a `registry.ts` import here would
 * close `models -> registry -> cursor/adapter -> models` into a runtime cycle. The dependency runs
 * one way: this module is a leaf, and everything that builds an adapter imports it.
 */
export const MODEL_STDOUT_PARSERS: Partial<Record<ProviderKind, (stdout: string) => readonly ModelOption[]>> = {
  cursor: parseCursorModels,
}

/**
 * The Claude Code CLI's selectable models -- MOVED into that provider's manifest
 * (`packages/domain/src/provider/claude-code.ts`) and re-exported here under the same name.
 *
 * THE SAME ARRAY OBJECT, deliberately: `listClaudeCodeModels()` hands it back by reference and
 * `test/models.test.ts:31` asserts `listing.models).toBe(CLAUDE_CODE_MODELS)`. A copy here would
 * satisfy `toEqual` and fail that line, which is the test doing exactly its job.
 *
 * The ternary is the discriminated union's narrowing and not defensiveness: `modelDiscovery` is a
 * union and TypeScript will not read `options` off it without the check. The `[]` arm is
 * unreachable for the row above it, and `models.test.ts`'s own `slice(0, 5)` case -- which an
 * empty list would fail -- is what says so.
 */
export const CLAUDE_CODE_MODELS: readonly ModelOption[] =
  CLAUDE_CODE_MANIFEST.modelDiscovery.mode === 'configured' ? CLAUDE_CODE_MANIFEST.modelDiscovery.options : []

export function listClaudeCodeModels(): ModelListing {
  return { models: CLAUDE_CODE_MODELS, source: 'static' }
}

/** Runs `<command> models` (default `cursor-agent`, 10 s) and parses it. Never throws. */
export async function listCursorModels(command = 'cursor-agent', timeoutMs = 10_000): Promise<ModelListing> {
  return listAccountModels('cursor', command, timeoutMs)
}

/**
 * A `listed` provider's models, read from the account by running the argv its manifest declares
 * (M56a R6).
 *
 * The branch is chosen by DATA now, not by a `case`: `modelDiscovery.mode` says whether this
 * provider's list is read or configured, `modelDiscovery.argv` says what to run, and
 * `MODEL_STDOUT_PARSERS[kind]` says how to read the answer. The same two answers as before, from
 * the same two code paths.
 *
 * Never throws, exactly as before: an `account` read that failed comes back with `error` set and
 * `models` empty, so a form can fall back to free text and say why. The message is the first line of
 * stderr, or `<binary> <argv> failed` -- which renders `cursor-agent models failed`, the string this
 * function produced before it was generic.
 */
async function listAccountModels(kind: ProviderKind, command: string, timeoutMs: number): Promise<ModelListing> {
  const manifest = manifestFor(kind)
  const discovery = manifest.modelDiscovery
  if (discovery.mode !== 'listed') return { models: [], source: 'account' }
  const parse = MODEL_STDOUT_PARSERS[kind]
  if (parse === undefined) return { models: [], source: 'account', error: `${manifest.invocation.binary}: no model parser` }
  try {
    const { stdout } = await run(command, [...discovery.argv], { timeout: timeoutMs, env: { ...process.env, NO_COLOR: '1' } })
    return { models: parse(stdout), source: 'account' }
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : (error as Error).message
    return {
      models: [],
      source: 'account',
      error: text.split('\n')[0] ?? `${manifest.invocation.binary} ${discovery.argv.join(' ')} failed`,
    }
  }
}

/** The one entry point the web reads (through `@slave-of-ai/control`'s re-export): a kind in, a
 *  listing out. The adapters' `listModels()` delegate here, so a caller with an adapter and a
 *  caller with only a kind see the same list.
 *
 *  M56a R6: no switch. `configured` answers the manifest's own table with `source: 'static'`,
 *  `listed` runs the manifest's argv and hands stdout to that kind's parser with
 *  `source: 'account'`, and `none` -- which no shipped provider declares -- answers an empty static
 *  listing rather than throwing, because "this provider lists nothing" is an answer and not a fault.
 *
 *  `options.cursorCommand` keeps its name and its meaning: `apps/web/src/server/models.ts` passes
 *  `SLAVEOFAI_CURSOR_BIN` into it and is the ONE caller, so renaming it would be a rename with no
 *  reader in a milestone that changes nothing. */
export async function listProviderModels(
  kind: ProviderKind,
  options?: { readonly cursorCommand?: string; readonly timeoutMs?: number },
): Promise<ModelListing> {
  const manifest = manifestFor(kind)
  if (manifest.modelDiscovery.mode === 'configured') {
    return { models: manifest.modelDiscovery.options, source: 'static' }
  }
  if (manifest.modelDiscovery.mode === 'none') return { models: [], source: 'static' }
  return listAccountModels(kind, options?.cursorCommand ?? manifest.invocation.binary, options?.timeoutMs ?? 10_000)
}
