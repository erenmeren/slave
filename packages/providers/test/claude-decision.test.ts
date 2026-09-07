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
  it('fails with a reason on a timeout and on a stream without a result line', async () => {
    const hung = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'hang'], timeoutMs: 500 })
    expect(hung).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/timeout/), costUsd: null })
    const crashed = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'crash'] })
    expect(crashed.kind).toBe('failed')
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
})
