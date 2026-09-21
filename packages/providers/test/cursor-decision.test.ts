import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { decideWithCursor, denyAllPermissions } from '../src/cursor/decision.js'
import { runTokenHash } from '../src/runtime/process.js'

const FAKE = fileURLToPath(new URL('./fake-cursor-print.mjs', import.meta.url))
const GATE = fileURLToPath(new URL('../../../scripts/cursor-shell-gate.sh', import.meta.url))
const base = { command: 'node', model: 'auto', prompt: 'what is going on?', gatePath: GATE }

const scratch: string[] = []
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A directory of this test's own, removed after it. */
async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-testscratch-'))
  scratch.push(dir)
  return dir
}

/** What `--dump <path>` wrote: the call's wiring, read from inside the child that lived in it. */
interface ChildDump {
  readonly cwd: string
  readonly env: Record<string, string | undefined>
  readonly hooks: unknown
  readonly permissions: unknown
  readonly tokenMatchesFile: boolean
  readonly argv: readonly string[]
}

async function dumpOf(path: string): Promise<ChildDump> {
  return JSON.parse(await readFile(path, 'utf8')) as ChildDump
}

describe('decideWithCursor (fake print-mode CLI)', () => {
  it('returns the assistant text with no cost, the usage it does report, and the fake reply envelope', async () => {
    const outcome = await decideWithCursor({ ...base, extraArgs: [FAKE, '--fixture', 'answer'] })
    expect(outcome.kind).toBe('answer')
    if (outcome.kind !== 'answer') return
    expect(outcome.text).toContain('"supervisorReply"')
    expect(outcome.text).toContain('from cursor')
    // MEASURED (spec §4 erratum E1): the terminal `result` line carries `usage` and no cost field
    // of any name, so a decision on this runtime is unmeasured. `null`, never `0`.
    expect(outcome.costUsd).toBeNull()
    expect(outcome.tokens).toEqual({ input: 20948 + 2304, output: 83 })
  })

  it("carries the vendor's preface line through untouched, so the envelope is still readable behind it", async () => {
    // The real binary opens its answer with "> Auto routed to <model>". Nothing here asserts that
    // wording -- it is the vendor's and it will change -- only that a preface does not cost us the
    // reply: `parseSupervisorReply` reads the FIRST JSON object in the text.
    const outcome = await decideWithCursor({ ...base, extraArgs: [FAKE, '--fixture', 'preface'] })
    expect(outcome.kind).toBe('answer')
    if (outcome.kind !== 'answer') return
    expect(outcome.text).toContain('"supervisorReply"')
    expect(outcome.text.indexOf('{')).toBeGreaterThan(0)
  })

  it('reports an isolation breach when the stream shows a tool call at all', async () => {
    const outcome = await decideWithCursor({ ...base, extraArgs: [FAKE, '--fixture', 'breach'] })
    expect(outcome).toMatchObject({ kind: 'isolation_breach', costUsd: null })
    if (outcome.kind !== 'isolation_breach') return
    expect(outcome.tools).toEqual(['read'])
  })

  it('fails with a reason on a stream that ends with no result line', async () => {
    const outcome = await decideWithCursor({ ...base, extraArgs: [FAKE, '--fixture', 'noresult'] })
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/without a result line/), costUsd: null })
  })

  it('fails with the runtime\'s own sentence when the result line is an error, and never calls it an answer', async () => {
    const outcome = await decideWithCursor({ ...base, extraArgs: [FAKE, '--fixture', 'error'] })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    // BOTH halves, as on the Claude side: the category this runtime reports (`subtype`) and the
    // sentence it wrote, which is the only part that says whether waiting would help.
    expect(outcome.reason).toContain('error')
    expect(outcome.reason).toContain('could not be completed')
    expect(outcome.costUsd).toBeNull()
  })

  it('fails with a reason on a timeout', async () => {
    const outcome = await decideWithCursor({ ...base, extraArgs: [FAKE, '--fixture', 'hang'], timeoutMs: 500 })
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/timeout/), costUsd: null })
  })

  it('spawns print mode with the trust flags, the model, and the prompt last and positional', async () => {
    const dumpPath = join(await scratchDir(), 'dump.json')
    await decideWithCursor({ ...base, prompt: 'the prompt', extraArgs: [FAKE, '--dump', dumpPath] })
    const { argv } = await dumpOf(dumpPath)
    for (const flag of ['--print', '--trust', '--force']) expect(argv).toContain(flag)
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(argv[argv.indexOf('--model') + 1]).toBe('auto')
    // Positional and LAST: `--resume [chatId]` takes an optional argument, so a prompt anywhere
    // else in this argv is a prompt some flag swallowed.
    expect(argv.at(-1)).toBe('the prompt')
  })

  it('gives the child a temp directory of its own with the gate registered in it, an all-deny verdict, and nothing of this process (R5)', async () => {
    const dumpPath = join(await scratchDir(), 'dump.json')
    process.env['DATABASE_URL'] = 'postgres://should-not-leak'
    try {
      await decideWithCursor({ ...base, extraArgs: [FAKE, '--dump', dumpPath] })
    } finally {
      delete process.env['DATABASE_URL']
    }
    const dump = await dumpOf(dumpPath)

    // A directory of the call's own, because `cursor-agent` reads its hooks from the workspace and
    // there is no `--settings`-style flag: the cwd IS the gate's registration.
    expect(dump.cwd).not.toBe(process.cwd())
    expect(dump.hooks).toEqual({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: `'${GATE}'`, failClosed: true }],
        preToolUse: [{ command: `'${GATE}'`, failClosed: true }],
      },
    })

    // The verdict the gate reads: version 2, nothing granted, nothing allowed, every tool
    // governed -- and about THIS child, which is what the token match proves.
    expect(dump.permissions).toMatchObject({ version: 2, enforce: 'all-tools', grants: [], allow: [] })
    expect(dump.tokenMatchesFile).toBe(true)

    // The pause flag is named (an unnamed one makes the gate deny with a misconfiguration message
    // before the matrix is ever read) and the file does not exist (a decision call is never paused).
    expect(dump.env['SLAVEOFAI_PAUSE_FLAG']).toMatch(/pause\.flag$/)
    expect(Object.keys(dump.env).sort()).toEqual([
      'HOME',
      'LANG',
      'PATH',
      'SLAVEOFAI_PAUSE_FLAG',
      'SLAVEOFAI_PERMISSIONS_FILE',
      'SLAVEOFAI_RUN_TOKEN',
      'TERM',
    ])
  })

  it('leaves no temp directory behind, whatever the outcome', async () => {
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith('slaveofai-cursor-decision-')).length
    await decideWithCursor({ ...base, extraArgs: [FAKE, '--fixture', 'answer'] })
    await decideWithCursor({ ...base, extraArgs: [FAKE, '--fixture', 'hang'], timeoutMs: 300 })
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith('slaveofai-cursor-decision-')).length
    expect(after).toBe(before)
  })

  it('refuses a gate script that does not discriminate, before anything is spawned', async () => {
    await expect(
      decideWithCursor({ ...base, gatePath: fileURLToPath(new URL('../../../scripts/deny-all-gate.sh', import.meta.url)) }),
    ).rejects.toThrow(/cursorPreflightGate/)
  })
})

describe('denyAllPermissions', () => {
  it('really denies a tool call at the Cursor gate, which is the whole claim the file makes', async () => {
    const dir = await scratchDir()
    const runToken = 'c'.repeat(64)
    const permissionsPath = join(dir, 'permissions.json')
    await writeFile(permissionsPath, JSON.stringify(denyAllPermissions({ runToken })))
    expect(denyAllPermissions({ runToken }).tokenHash).toBe(runTokenHash(runToken))

    const verdict = await runGate({
      payload: JSON.stringify({ tool_name: 'Read' }),
      env: {
        SLAVEOFAI_PAUSE_FLAG: join(dir, 'pause.flag'),
        SLAVEOFAI_PERMISSIONS_FILE: permissionsPath,
        SLAVEOFAI_RUN_TOKEN: runToken,
      },
    })
    expect(verdict.exitCode).toBe(0)
    expect(JSON.parse(verdict.stdout) as { permission: string }).toMatchObject({ permission: 'deny' })
  })
})

/** Spawns the Cursor gate the way `cursor-agent` would: the payload on stdin, the verdict on stdout. */
function runGate(input: {
  readonly payload: string
  readonly env: NodeJS.ProcessEnv
}): Promise<{ readonly stdout: string; readonly exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(GATE, [], { env: { PATH: process.env['PATH'] ?? '', ...input.env }, stdio: ['pipe', 'pipe', 'pipe'] })
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
