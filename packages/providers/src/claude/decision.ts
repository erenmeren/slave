import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGateScript } from '../runtime/gate-preflight.js'
import { terminateChild } from '../runtime/process.js'
import { parseStreamLine } from './stream.js'
import { writeSettingsFile } from './settings.js'
import type { RunOutcome } from '../types.js'

export const DEFAULT_MODEL_TIMEOUT_MS = 120_000

export interface ModelDecisionInput {
  readonly command: string
  readonly extraArgs?: readonly string[]
  readonly model: string
  readonly prompt: string
  readonly maxBudgetUsd: number
  readonly hookPath: string
  readonly timeoutMs?: number
}

export type ModelDecisionOutcome =
  | {
      readonly kind: 'answer'
      readonly text: string
      readonly costUsd: number | null
      readonly tokens: { readonly input: number; readonly output: number } | null
      readonly numTurns: number
    }
  | {
      readonly kind: 'isolation_breach'
      readonly tools: readonly string[]
      readonly costUsd: number | null
      readonly tokens: { readonly input: number; readonly output: number } | null
    }
  | {
      readonly kind: 'failed'
      readonly reason: string
      readonly costUsd: number | null
      readonly tokens: { readonly input: number; readonly output: number } | null
    }

/**
 * The exact flag set a simulation's model call spawns with: restricted, MCP-strict, tool-less
 * (`--tools ""`), session-less, budget-capped, `stream-json` output with hook events included, and
 * the per-run settings file that registers the deny-all hook (M31a §4). `extraArgs` come first --
 * the fake CLI's own `node <fake.mjs> --fixture <name>` invocation shape -- everything after it is
 * flags the real (or fake) `claude` binary reads.
 */
export function decisionArgs(input: {
  readonly extraArgs?: readonly string[]
  readonly model: string
  readonly maxBudgetUsd: number
  readonly settingsPath: string
}): readonly string[] {
  return [
    ...(input.extraArgs ?? []),
    '-p',
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    '',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--model',
    input.model,
    '--max-budget-usd',
    String(input.maxBudgetUsd),
    '--settings',
    input.settingsPath,
  ]
}

/**
 * The environment a decision call's child is spawned with: exactly `PATH`, `HOME`, `LANG` and
 * `TERM` -- never the parent's full `process.env`, which on this repo's own processes carries
 * `DATABASE_URL` and other secrets a simulation actor must never see (M31a §4, ruling R1). `PATH`
 * and `HOME` come from the parent's own environment (the child needs them to find `node`/`claude`
 * and resolve its home directory); `LANG` falls back to `'C.UTF-8'` when the parent has none;
 * `TERM` is always `'dumb'` -- a decision call is never interactive and never needs a real
 * terminal's capabilities.
 */
export function buildDecisionEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    TERM: 'dumb',
  }
}

function isDeny(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision === 'deny'
  } catch {
    return false
  }
}

/** The deny-all hook must deny whatever the pause flag says -- the opposite contract of `preflightGate`. */
export async function preflightDenyAll(input: { readonly hookPath: string }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-denyall-'))
  try {
    for (const flagPresent of [true, false]) {
      const run = await runGateScript({ hookPath: input.hookPath, flagPath: join(dir, 'flag'), flagPresent })
      if (run.exitCode !== 0 || !isDeny(run.stdout)) {
        throw new Error(
          `preflightDenyAll: hook at ${input.hookPath} did not deny with the pause flag ${flagPresent ? 'present' : 'absent'} (exit ${String(run.exitCode)}, stdout ${JSON.stringify(run.stdout.slice(0, 200))})`,
        )
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function decideWithModel(input: ModelDecisionInput): Promise<ModelDecisionOutcome> {
  await preflightDenyAll({ hookPath: input.hookPath })
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-decision-'))
  const settingsPath = join(dir, 'settings.json')
  writeSettingsFile({ settingsPath, hookPath: input.hookPath })
  const env = buildDecisionEnv()
  const child = spawn(
    input.command,
    decisionArgs({
      ...(input.extraArgs !== undefined ? { extraArgs: input.extraArgs } : {}),
      model: input.model,
      maxBudgetUsd: input.maxBudgetUsd,
      settingsPath,
    }),
    { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  child.stdin.end(input.prompt)
  // A plain mutable object rather than several `let`s: TS's control-flow analysis of a `let`
  // reassigned only inside a nested closure (`handleLine`, called from the `data`/`close`
  // listeners below) narrows the outer reads of that `let` to `never` after the closure runs --
  // reproduced in isolation, not specific to this file -- where a property on a held object
  // narrows correctly. See git history for the `let outcome: RunOutcome | null` version this
  // replaced and its `tsc` errors.
  const state: { text: string; tools: string[]; outcome: RunOutcome | null } = { text: '', tools: [], outcome: null }
  let buffer = ''
  let timedOut = false
  const timer = setTimeout((): void => {
    timedOut = true
    void terminateChild(child, 2_000)
  }, input.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS)
  const handleLine = (line: string): void => {
    if (line.trim() === '') return
    const event = parseStreamLine(line)
    if (event.kind === 'text') state.text += event.text
    else if (event.kind === 'tool_call') state.tools.push(event.toolName)
    else if (event.kind === 'terminated') state.outcome = event.outcome
  }
  try {
    await new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        lines.forEach(handleLine)
      })
      child.on('close', (): void => {
        if (buffer !== '') handleLine(buffer)
        resolve()
      })
      child.on('error', (): void => resolve())
    })
  } finally {
    clearTimeout(timer)
    await rm(dir, { recursive: true, force: true })
  }
  const { text, tools, outcome } = state
  const costUsd = outcome?.costUsd ?? null
  const tokens = outcome?.tokens ?? null
  // Order matters: a crashed or hung run can still have emitted a tool_use block before it died
  // (measured -- `fixtures/crash.ndjson`'s first half already contains one), and that must not
  // read as an `isolation_breach` -- a breach classification means the model *finished* a turn
  // while ignoring the deny-all hook, which requires a result line to say so. No result line at
  // all is simply a failed run, tool call notwithstanding, so `timedOut` and `outcome === null`
  // are both checked before `tools.length > 0`.
  if (timedOut) return { kind: 'failed', reason: 'timeout', costUsd, tokens }
  if (outcome === null) return { kind: 'failed', reason: 'the model process ended without a result line', costUsd, tokens }
  if (tools.length > 0) return { kind: 'isolation_breach', tools, costUsd, tokens }
  if (outcome.isError) return { kind: 'failed', reason: `result is_error: ${outcome.terminalReason}`, costUsd, tokens }
  return { kind: 'answer', text, costUsd, tokens, numTurns: outcome.numTurns }
}
