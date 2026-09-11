import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_ERROR_CLASSES, classifyToolError } from '../src/tool-result.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const tapPath = path.join(repoRoot, 'scripts/tool-result-tap.sh')

const createdDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-tap-test-'))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
  createdDirs.length = 0
})

/** The absolute path of `tool` on this process's PATH, or null when it is not there. */
function resolveOnPath(tool: string): string | null {
  for (const entry of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (entry === '') continue
    const candidate = path.join(entry, tool)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not there, or not readable. Next entry.
    }
  }
  return null
}

interface TapResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly lines: readonly Record<string, unknown>[]
}

/**
 * Spawns the real `scripts/tool-result-tap.sh` once per payload, against ONE
 * `SLAVEOFAI_TOOL_RESULTS` file, the way `cursor-shell-gate.test.ts` spawns the real gate:
 * piped stdio, the payload written and the pipe closed (the script reads stdin whole, so nothing
 * else would ever end it).
 */
async function runTapRaw(...payloads: readonly string[]): Promise<TapResult> {
  const dir = tempDir()
  const resultsPath = path.join(dir, 'tool-results.ndjson')
  let stdout = ''
  let stderr = ''
  let exitCode: number | null = 0
  for (const payload of payloads) {
    const one = await spawnTap(payload, { SLAVEOFAI_TOOL_RESULTS: resultsPath })
    stdout += one.stdout
    stderr += one.stderr
    exitCode = one.exitCode
  }
  const lines = existsSync(resultsPath)
    ? readFileSync(resultsPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
  return { stdout, stderr, exitCode, lines }
}

function runTap(...payloads: readonly unknown[]): Promise<TapResult> {
  return runTapRaw(...payloads.map((payload) => JSON.stringify(payload)))
}

async function runTapWithoutEnv(payload: unknown): Promise<TapResult> {
  const one = await spawnTap(JSON.stringify(payload), { SLAVEOFAI_TOOL_RESULTS: undefined })
  return { ...one, lines: [] }
}

function spawnTap(
  payload: string,
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  if (env['SLAVEOFAI_TOOL_RESULTS'] === undefined) delete childEnv['SLAVEOFAI_TOOL_RESULTS']
  return new Promise((resolve, reject) => {
    const child = spawn(tapPath, [], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (exitCode: number | null) => resolve({ stdout, stderr, exitCode }))
    child.stdin.end(payload)
  })
}

describe('scripts/tool-result-tap.sh', () => {
  it('writes ONE bounded NDJSON line per call and says nothing on stdout', async () => {
    const { stdout, exitCode, lines } = await runTap({
      tool_use_id: 'toolu_1',
      tool_name: 'Bash',
      tool_response: { is_error: false },
    })
    expect(exitCode).toBe(0)
    // A PostToolUse hook that speaks is a hook whose stdout the CLI parses. This one has nothing to
    // say -- it is a tap, not a gate.
    expect(stdout).toBe('')
    expect(lines).toEqual([{ toolUseId: 'toolu_1', toolName: 'Bash', outcome: 'ok', errorClass: null }])
  })

  it('reports a failed call with a class and never the response body', async () => {
    const { lines } = await runTap({
      tool_use_id: 'toolu_2',
      tool_name: 'Bash',
      tool_response: { is_error: true, content: 'API Error: 529 and here is the whole log' },
    })
    expect(lines[0]).toMatchObject({ outcome: 'error', errorClass: 'api_error' })
    expect(JSON.stringify(lines)).not.toContain('here is the whole log')
  })

  it('appends, so a run’s calls accumulate in order', async () => {
    const { lines } = await runTap(
      { tool_use_id: 'a', tool_name: 'Read', tool_response: {} },
      { tool_use_id: 'b', tool_name: 'Write', tool_response: {} },
    )
    expect(lines.map((line) => line['toolUseId'])).toEqual(['a', 'b'])
  })

  it('caps its own line and stays exit 0 on a payload it cannot read', async () => {
    const { exitCode, stdout, lines } = await runTapRaw('{not json')
    // FAIL OPEN, loudly on stderr and silently on stdout. A PostToolUse hook that exits non-zero
    // would interfere with a run for the sake of a diagnostic -- the opposite of the ruling that
    // the STREAM wins and the tap only fills a gap.
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
    expect(lines).toEqual([])
  })

  it('writes nothing at all when SLAVEOFAI_TOOL_RESULTS is unset', async () => {
    const { exitCode, stdout } = await runTapWithoutEnv({ tool_use_id: 'x', tool_name: 'Read', tool_response: {} })
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
  })

  it('refuses to write a line past TAP_LINE_MAX_BYTES rather than writing a truncated one', async () => {
    // A tool name a runtime should never send, and the bound that makes the file readable by a
    // line-oriented tailer regardless: an over-long line is DROPPED, not cut, because a cut line
    // is invalid JSON the adapter's tailer would then have to be defensive about.
    const { exitCode, lines } = await runTap({
      tool_use_id: 'toolu_big',
      tool_name: 'N'.repeat(8_000),
      tool_response: { is_error: false },
    })
    expect(exitCode).toBe(0)
    expect(lines).toEqual([])
  })

  it('records nothing for a payload that names no tool_use_id -- an unpairable result is not evidence', async () => {
    // Both fields are `z.string().min(1)` on the wire (`run.tool_result`, M51 Task 2), and a result
    // nobody can pair back to a call is not a fact the detector can use.
    const { exitCode, lines } = await runTap({ tool_name: 'Bash', tool_response: { is_error: false } })
    expect(exitCode).toBe(0)
    expect(lines).toEqual([])
  })

  it('falls back to grep when there is no node on the PATH the runtime spawns hooks with', async () => {
    // The fallback is BEST-EFFORT and bounded, and this is what pins that it produces the same four
    // fields rather than nothing: a hook is invoked by an external binary whose PATH this system
    // does not control, and a tap that only works when `node` happens to be on it is a tap that
    // silently records nothing on the deployment that needed it most.
    const dir = tempDir()
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    // `env` and `bash` are the shebang's own needs; `cat`, `grep` and `head` are the fallback's.
    for (const tool of ['env', 'bash', 'cat', 'grep', 'head']) {
      const resolved = resolveOnPath(tool)
      if (resolved === null) return // nothing to prove on a box without coreutils
      symlinkSync(resolved, path.join(bin, tool))
    }
    const resultsPath = path.join(dir, 'tool-results.ndjson')
    const one = await spawnTap(
      JSON.stringify({ tool_use_id: 'toolu_grep', tool_name: 'Read', tool_response: { is_error: true, content: 'ENOENT' } }),
      { SLAVEOFAI_TOOL_RESULTS: resultsPath, PATH: bin },
    )
    expect(one.exitCode).toBe(0)
    expect(one.stdout).toBe('')
    expect(JSON.parse(readFileSync(resultsPath, 'utf8').trim())).toEqual({
      toolUseId: 'toolu_grep',
      toolName: 'Read',
      outcome: 'error',
      errorClass: 'not_found',
    })
  })

  it('classifies exactly the way classifyToolError does -- the shell twin cannot drift alone', async () => {
    // The SHELL twin of `packages/providers/src/tool-result.ts`, pinned case by case the way
    // `scripts/lib/permissions.sh` is pinned against `PERMISSION_DENY_REASON_PREFIX`.
    const texts = [
      'API Error: 529 overloaded',
      'Command timed out after 120000ms',
      'ENOENT: no such file or directory',
      'EACCES: permission denied, open ...',
      'the tests failed',
    ]
    const { lines } = await runTap(
      ...texts.map((content, index) => ({
        tool_use_id: `t${String(index)}`,
        tool_name: 'Bash',
        tool_response: { is_error: true, content },
      })),
    )
    expect(lines.map((line) => line['errorClass'])).toEqual(texts.map((text) => classifyToolError(text)))
    for (const line of lines) expect(TOOL_ERROR_CLASSES).toContain(line['errorClass'])
  })
})
