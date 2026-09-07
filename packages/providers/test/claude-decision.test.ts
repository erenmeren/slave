import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildDecisionEnv, decideWithModel, decisionArgs, preflightDenyAll } from '../src/claude/decision.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('../../../scripts/deny-all-gate.sh', import.meta.url))
const base = { command: 'node', model: 'claude-haiku-4-5-20251001', prompt: 'observe and decide', maxBudgetUsd: 0.5, hookPath: HOOK }

describe('decisionArgs', () => {
  it('spawns restricted, MCP-strict, tool-less, session-less, budget-capped, with the settings file, and puts extra args first', () => {
    const args = decisionArgs({ extraArgs: ['/fake', '--fixture', 'decision'], model: 'm', maxBudgetUsd: 0.25, settingsPath: '/tmp/x/settings.json' })
    expect(args.slice(0, 3)).toEqual(['/fake', '--fixture', 'decision'])
    for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--include-hook-events']) expect(args).toContain(flag)
    expect(args).toContain('--tools')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--model') + 1]).toBe('m')
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.25')
    expect(args[args.indexOf('--settings') + 1]).toBe('/tmp/x/settings.json')
    expect(args).not.toContain('--permission-mode')
  })
})

describe('preflightDenyAll', () => {
  it('accepts the deny-all hook and refuses the pause gate (which allows without a flag)', async () => {
    await expect(preflightDenyAll({ hookPath: HOOK })).resolves.toBeUndefined()
    await expect(preflightDenyAll({ hookPath: fileURLToPath(new URL('../../../scripts/pause-gate.sh', import.meta.url)) })).rejects.toThrow(/did not deny/)
  })
})

describe('buildDecisionEnv', () => {
  it('carries exactly PATH, HOME, LANG and TERM, even when other env vars are set', () => {
    process.env['DATABASE_URL'] = 'postgres://should-not-leak'
    process.env['SLAVEOFAI_TEST_LEAK'] = '1'
    expect(Object.keys(buildDecisionEnv()).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
    delete process.env['DATABASE_URL']
    delete process.env['SLAVEOFAI_TEST_LEAK']
  })
})

describe('decideWithModel (fake CLI)', () => {
  it('returns the answer text with cost and tokens, sends the prompt on stdin, and passes a clean environment', async () => {
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'decision'] })
    expect(outcome.kind).toBe('answer')
    if (outcome.kind !== 'answer') return
    expect(outcome.text).toContain('place_purchase')
    expect(outcome.costUsd).toBeCloseTo(0.0038, 6)
    expect(outcome.tokens).toEqual({ input: 900, output: 120 })
    expect(outcome.numTurns).toBe(1)
  })
  it('reports an isolation breach when the stream shows a tool call, keeping the cost', async () => {
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'decision-breach'] })
    expect(outcome).toMatchObject({ kind: 'isolation_breach', tools: ['Bash'], costUsd: 0.0121 })
  })
  it('fails with a reason on a timeout', async () => {
    const hung = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'hang'], timeoutMs: 500 })
    expect(hung).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/timeout/), costUsd: null })
  })
  it('fails with a reason on a stream that ends with no result line and no tool call', async () => {
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'decision-noresult'] })
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/without a result line/), costUsd: null })
  })
  it('reports an isolation breach when a tool call is seen even though the stream then crashes with no result line (R2: breach outweighs a missing result)', async () => {
    const crashed = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'crash'] })
    expect(crashed).toMatchObject({ kind: 'isolation_breach', costUsd: null })
    if (crashed.kind === 'isolation_breach') expect(crashed.tools).toContain('Write')
  })
  it('gives the child only PATH, HOME, LANG and TERM (env-echo replays its own env in a field decideWithModel never surfaces)', async () => {
    process.env['DATABASE_URL'] = 'postgres://should-not-leak'
    process.env['SLAVEOFAI_TEST_LEAK'] = '1'
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'env-echo'] })
    expect(outcome.kind).toBe('answer')
    if (outcome.kind === 'answer') expect(outcome.numTurns).toBe(1)
    delete process.env['DATABASE_URL']
    delete process.env['SLAVEOFAI_TEST_LEAK']
  })
  it('rejects a non-absolute hookPath and leaves no slaveofai-decision-* temp dir behind', async () => {
    // A relative path that still spawns and denies correctly (so `preflightDenyAll` passes and
    // `decideWithModel` reaches its own `mkdtemp('slaveofai-decision-')` and `writeSettingsFile`,
    // which is what actually exercises the try/finally reordering this test guards -- a hookPath
    // relative segment that does not resolve at all (e.g. `'relative/hook.sh'`) fails earlier, in
    // `preflightDenyAll`'s own spawn, before any `slaveofai-decision-*` dir would ever exist either
    // way, and would pass this assertion without testing anything.
    const relativeHookPath = 'scripts/deny-all-gate.sh'
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith('slaveofai-decision-')).length
    await expect(decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'decision'], hookPath: relativeHookPath })).rejects.toThrow(/absolute/)
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith('slaveofai-decision-')).length
    expect(after).toBe(before)
  })
})
