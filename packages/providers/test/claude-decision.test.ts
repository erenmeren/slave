import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDecisionEnv, decideWithModel, decisionArgs, preflightDenyAll } from '../src/claude/decision.js'
import { runTokenHash } from '../src/runtime/process.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('../../../scripts/deny-all-gate.sh', import.meta.url))
const PAUSE_GATE = fileURLToPath(new URL('../../../scripts/pause-gate.sh', import.meta.url))
const base = { command: 'node', model: 'claude-haiku-4-5-20251001', prompt: 'observe and decide', maxBudgetUsd: 0.5, hookPath: HOOK }

const scratch: string[] = []
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-decision-test-'))
  scratch.push(dir)
  return dir
}

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

describe('decisionArgs in read-only tool mode (R7)', () => {
  const settingsPath = '/tmp/x/settings.json'

  it('asks for Read, Glob and Grep, and changes nothing else about the spawn', () => {
    const readOnly = decisionArgs({ model: 'm', maxBudgetUsd: 0.25, settingsPath, tools: 'read-only' })
    const textOnly = decisionArgs({ model: 'm', maxBudgetUsd: 0.25, settingsPath })
    expect(readOnly[readOnly.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
    // Exactly one word apart: the mode is a tool list, not a different spawn. `--restricted`,
    // `--strict-mcp-config` and `--no-session-persistence` still hold.
    expect(readOnly.filter((arg, index) => arg !== textOnly[index])).toEqual(['Read,Glob,Grep'])
  })

  it("leaves `tools: 'none'` and an input that names no mode identical, byte for byte", () => {
    const unnamed = decisionArgs({ model: 'm', maxBudgetUsd: 0.25, settingsPath })
    expect(decisionArgs({ model: 'm', maxBudgetUsd: 0.25, settingsPath, tools: 'none' })).toEqual(unnamed)
    expect(unnamed[unnamed.indexOf('--tools') + 1]).toBe('')
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
  it('gets M38\'s supervisor answer out of a flow mode, prompt and all, exactly as the gate will', async () => {
    // The whole seam in one call: `decisionArgs` puts the prompt on STDIN behind a bare `-p`, the
    // fake CLI is in a FLOW mode (which is what a gate sets for its runs, not a static fixture),
    // and the supervisor arm has to recognise the prompt anyway and replay the decision fixture
    // instead of the work body.
    const outcome = await decideWithModel({
      ...base,
      prompt: 'CANDIDATE ACTIONS\n0. unblock_task\n\nReply with {"candidateIndex": <0..3>, "rationale": "..."}',
      extraArgs: [FAKE, '--fixture', 'm8a-flow'],
    })
    expect(outcome.kind).toBe('answer')
    if (outcome.kind !== 'answer') return
    expect(outcome.text).toContain('"candidateIndex":0')
    expect(outcome.costUsd).toBeCloseTo(0.01, 6)
  })
  it('reports an isolation breach when the stream shows a tool call, keeping the cost', async () => {
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'decision-breach'] })
    expect(outcome).toMatchObject({ kind: 'isolation_breach', tools: ['Bash'], costUsd: 0.0121 })
  })
  it('fails with a reason on a timeout', async () => {
    const hung = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'hang'], timeoutMs: 500 })
    expect(hung).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/timeout/), costUsd: null })
  })
  it("names the runtime's own explanation in the reason, not just the error category", async () => {
    // The failure a real account hits most often (an exhausted spend limit) reaches this function
    // as `terminal_reason: 'api_error'` -- a category that reads identically to a passing upstream
    // fault. The reason carries BOTH: the category, for anything matching on it, and the sentence
    // the CLI wrote, which is the only part that tells a person whether waiting will help.
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'decision-api-error'] })
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringContaining('api_error') })
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toContain('monthly spend limit')
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

describe('decideWithModel in read-only tool mode (F R7)', () => {
  /** What one `--env-out` line carries: the spawn as the child itself saw it. */
  interface ChildDump {
    readonly cwd: string
    readonly argv: readonly string[]
    readonly env: Record<string, string | undefined>
    readonly settings: { readonly hooks?: unknown } | null
  }

  async function readOnlyCall(overrides: Record<string, unknown> = {}): Promise<ChildDump> {
    const dir = await scratchDir()
    const repoPath = join(dir, 'repo')
    await mkdir(repoPath)
    const dumpPath = join(dir, 'env.ndjson')
    const outcome = await decideWithModel({
      ...base,
      hookPath: PAUSE_GATE,
      tools: 'read-only',
      cwd: repoPath,
      permissionsFilePath: join(dir, 'permissions.json'),
      runToken: 'a'.repeat(64),
      extraArgs: [FAKE, '--fixture', 'env-echo', '--env-out', dumpPath],
      ...overrides,
    })
    expect(outcome.kind).toBe('answer')
    return JSON.parse((await readFile(dumpPath, 'utf8')).trim()) as ChildDump
  }

  it('accepts the run gate, which the deny-all pre-flight would have refused', async () => {
    // The whole reason read-only mode cannot keep `preflightDenyAll`: that check requires the hook
    // to deny with the pause flag ABSENT, and a run gate allows there -- it is the discrimination
    // that makes it a gate. `preflightDenyAll({ hookPath: PAUSE_GATE })` rejects (asserted in this
    // file's own `preflightDenyAll` suite); the same script must be accepted here.
    const dump = await readOnlyCall()
    expect(dump.argv[dump.argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
  })

  it('refuses a hook that never allows, because a run gate that cannot discriminate gates nothing', async () => {
    await expect(
      decideWithModel({ ...base, tools: 'read-only', cwd: tmpdir(), extraArgs: [FAKE, '--fixture', 'env-echo'] }),
    ).rejects.toThrow(/did not allow/)
  })

  it('spawns in the repository, with the permissions file, its token, and a pause flag that does not exist', async () => {
    process.env['DATABASE_URL'] = 'postgres://should-not-leak'
    let dump: ChildDump
    try {
      dump = await readOnlyCall()
    } finally {
      delete process.env['DATABASE_URL']
    }
    expect(dump.cwd).toMatch(/repo/u)
    expect(dump.env['SLAVEOFAI_PERMISSIONS_FILE']).toMatch(/permissions\.json$/u)
    // Redacted to `<present>` by the fake: the plaintext token is the capability itself.
    expect(dump.env['SLAVEOFAI_RUN_TOKEN']).toBe('<present>')
    // Named, and pointing at a file that does not exist. An UNSET pause flag makes both gates deny
    // every tool call with a misconfiguration message, before the permissions file is ever read --
    // which would make read-only mode read nothing.
    expect(dump.env['SLAVEOFAI_PAUSE_FLAG']).toMatch(/pause\.flag$/u)
    expect(Object.keys(dump.env).sort()).toEqual([
      'HOME',
      'LANG',
      'PATH',
      'SLAVEOFAI_PAUSE_FLAG',
      'SLAVEOFAI_PERMISSIONS_FILE',
      'SLAVEOFAI_RUN_TOKEN',
      'TERM',
    ])
    // The settings file the child was pointed at registers the hook it was given -- the run gate
    // here, the deny-all hook on a text-only turn. One mechanism, two scripts.
    expect(JSON.stringify(dump.settings)).toContain(PAUSE_GATE)
  })

  it('keeps a text-only turn exactly as it was: the temp dir as cwd, and no permissions file at all', async () => {
    const dir = await scratchDir()
    const dumpPath = join(dir, 'env.ndjson')
    const outcome = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'env-echo', '--env-out', dumpPath] })
    expect(outcome.kind).toBe('answer')
    const dump = JSON.parse((await readFile(dumpPath, 'utf8')).trim()) as ChildDump
    expect(dump.argv[dump.argv.indexOf('--tools') + 1]).toBe('')
    expect(dump.cwd).toMatch(/slaveofai-decision-/u)
    expect(Object.keys(dump.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
    expect(JSON.stringify(dump.settings)).toContain(HOOK)
  })

  it('does not call an allowed Read a breach, and still calls everything else one', async () => {
    // THE REGRESSION THIS MODE WOULD OTHERWISE BE. `--include-hook-events` puts every tool call in
    // the stream, and a text-only turn reads ANY tool call as an isolation breach -- the deny-all
    // hook was supposed to make one impossible. Under `read-only` a `Read` is the entire point, so
    // the breach test is the tools that were NOT asked for. `permission-matrix-deny` replays a
    // `Read` and then a `Bash`: the `Bash` is still a breach, and it is named alone.
    const dir = await scratchDir()
    const breach = await decideWithModel({
      ...base,
      hookPath: PAUSE_GATE,
      tools: 'read-only',
      cwd: dir,
      extraArgs: [FAKE, '--fixture', 'permission-matrix-deny'],
    })
    expect(breach.kind).toBe('isolation_breach')
    if (breach.kind !== 'isolation_breach') return
    expect(breach.tools).toEqual(['Bash'])

    // The same stream on a text-only turn: both calls are breaches, unchanged.
    const strict = await decideWithModel({ ...base, extraArgs: [FAKE, '--fixture', 'permission-matrix-deny'] })
    expect(strict).toMatchObject({ kind: 'isolation_breach', tools: ['Read', 'Bash'] })
  })

  it('is really read-only at the gate: a read_repo verdict allows Read and denies Bash (the contract the caller writes to)', async () => {
    // The file itself is the caller's to write (R7: "the existing gate, the existing file format").
    // What is asserted here is the pairing this function is responsible for -- the gate script, the
    // token in the child's environment, and a pause flag that is not armed -- against the verdict
    // shape the caller is expected to produce.
    const dir = await scratchDir()
    const runToken = 'b'.repeat(64)
    const permissionsPath = join(dir, 'permissions.json')
    await writeFile(
      permissionsPath,
      JSON.stringify({
        version: 2,
        runId: 'read-only-turn',
        tokenHash: runTokenHash(runToken),
        enforce: 'all-tools',
        grants: ['read_repo'],
        allow: [],
        vocabulary: { Read: 'read_repo', Glob: 'read_repo', Grep: 'read_repo', Bash: 'run_commands' },
        prefixes: [],
      }),
    )
    const env = {
      SLAVEOFAI_PAUSE_FLAG: join(dir, 'pause.flag'),
      SLAVEOFAI_PERMISSIONS_FILE: permissionsPath,
      SLAVEOFAI_RUN_TOKEN: runToken,
    }
    const read = await runHook({ payload: JSON.stringify({ tool_name: 'Read' }), env })
    // Claude's gate allows by staying silent.
    expect(read).toEqual({ stdout: '', exitCode: 0 })
    const bash = await runHook({ payload: JSON.stringify({ tool_name: 'Bash' }), env })
    expect(bash.exitCode).toBe(0)
    expect(bash.stdout).toContain('"deny"')
  })
})

/** Spawns the Claude gate the way the CLI would: the payload on stdin, the verdict on stdout. */
function runHook(input: {
  readonly payload: string
  readonly env: NodeJS.ProcessEnv
}): Promise<{ readonly stdout: string; readonly exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PAUSE_GATE, [], {
      env: { PATH: process.env['PATH'] ?? '', ...input.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.resume()
    child.once('error', reject)
    child.once('close', (exitCode: number | null) => resolve({ stdout, exitCode }))
    child.stdin.end(input.payload)
  })
}
