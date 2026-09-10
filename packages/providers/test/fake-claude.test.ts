import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const FIXTURES_DIR = path.join(path.dirname(FAKE), 'fixtures')

type Line = { type: string; [key: string]: unknown }

function parseLines(stdout: string): Line[] {
  return stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line)
}

describe('fake-claude', () => {
  it('replays a fixture as NDJSON on stdout', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'complete'])
    const lines = parseLines(stdout)
    expect(lines[0]?.type).toBe('system')
    expect(lines.at(-1)?.type).toBe('system')
    const last = lines.at(-1) as Line
    expect(last.subtype).toBe('hook_response')
    expect(last.hook_event).toBe('Stop')
  })

  it('exits non-zero and truncates the stream in crash mode', async (): Promise<void> => {
    await expect(run('node', [FAKE, '--fixture', 'crash'])).rejects.toMatchObject({ code: 1 })
  })

  it('accepts the real CLI flags without choking', async (): Promise<void> => {
    const { stdout } = await run('node', [
      FAKE,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--settings',
      '/tmp/does-not-need-to-exist.json',
      '--include-hook-events',
      '-p',
      'do the thing',
      '--resume',
      'some-session-id',
      '--fixture',
      'complete',
    ])
    const lines = parseLines(stdout)
    expect(lines[0]?.type).toBe('system')
  })

  it('tolerates an unknown --model flag: still replays the requested fixture', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--model', 'whatever', '--fixture', 'complete'])
    const lines = parseLines(stdout)
    expect(lines[0]?.type).toBe('system')
    const last = lines.at(-1) as Line
    expect(last.subtype).toBe('hook_response')
    expect(last.hook_event).toBe('Stop')
  })

  it('produces every mode named in the brief plus hook-crash, hook-fail-open, and env-echo', async (): Promise<void> => {
    for (const mode of ['complete', 'hook-deny', 'hook-crash', 'hook-fail-open', 'permission-denied', 'malformed']) {
      const { stdout } = await run('node', [FAKE, '--fixture', mode])
      expect(stdout.trim().split('\n').length).toBeGreaterThan(0)
    }
  })

  it('every fixture file ends with the routine Stop hook line', async (): Promise<void> => {
    const fs = await import('node:fs/promises')
    const files = (await fs.readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.ndjson'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = await fs.readFile(path.join(FIXTURES_DIR, file), 'utf8')
      const lines = content
        .trim()
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l) as Line
          } catch {
            return null
          }
        })
        .filter((l): l is Line => l !== null)
      const last = lines.at(-1)
      expect(last?.type, `${file} must end with the routine Stop hook line`).toBe('system')
      expect(last?.subtype).toBe('hook_response')
      expect(last?.hook_event).toBe('Stop')
      expect(last?.exit_code).toBe(1)
      expect(last?.outcome).toBe('cancelled')
    }
  })

  it('hook-crash blocks the tool call: no PostToolUse fires for it', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'hook-crash'])
    const lines = parseLines(stdout)
    const crashResponses = lines.filter(
      (l) => l.type === 'system' && l.subtype === 'hook_response' && l.hook_event === 'PreToolUse' && l.exit_code === 2,
    )
    expect(crashResponses.length).toBeGreaterThan(0)
    expect(stdout).not.toContain('PostToolUse')
  })

  it('hook-fail-open lets the tool proceed after the gate breaks', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'hook-fail-open'])
    const lines = parseLines(stdout)
    const failedOpen = lines.filter(
      (l) =>
        l.type === 'system' &&
        l.subtype === 'hook_response' &&
        l.hook_event === 'PreToolUse' &&
        typeof l.exit_code === 'number' &&
        l.exit_code !== 0 &&
        l.exit_code !== 2,
    )
    expect(failedOpen.length).toBeGreaterThan(0)
    // The terminal result must show nothing was actually denied.
    const result = lines.find((l) => l.type === 'result') as
      | { permission_denials?: unknown[]; is_error?: boolean }
      | undefined
    expect(result?.is_error).toBe(false)
    expect(result?.permission_denials).toEqual([])
  })

  it('env-echo carries the child process environment in the terminal result', async (): Promise<void> => {
    const { stdout } = await run(
      'node',
      [FAKE, '--fixture', 'env-echo'],
      { env: { ...process.env, SLAVEOFAI_PROBE_VAR: 'probe-value' } },
    )
    const lines = parseLines(stdout)
    const result = lines.find((l) => l.type === 'result') as { env?: Record<string, string> } | undefined
    expect(result?.env?.SLAVEOFAI_PROBE_VAR).toBe('probe-value')
  })

  it('env-echo also carries the child process cwd in the terminal result', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'env-echo'], { cwd: FIXTURES_DIR })
    const lines = parseLines(stdout)
    const result = lines.find((l) => l.type === 'result') as { cwd?: string } | undefined
    expect(result?.cwd).toBe(FIXTURES_DIR)
  })

  it('hang mode writes nothing and does not exit on its own', async (): Promise<void> => {
    const child = await import('node:child_process').then((m) => m.spawn('node', [FAKE, '--fixture', 'hang']))
    let sawExit = false
    child.on('exit', () => {
      sawExit = true
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sawExit).toBe(false)
    child.kill('SIGKILL')
  })

  it('review-approve replays a fixture whose text carries an approve verdict', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'review-approve'])
    const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
    expect(result?.result).toContain('"verdict":"approve"')
  })

  it('plan-graph replays a fixture whose result carries a task graph', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'plan-graph'])
    const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
    expect(result?.result).toContain('"key":"core"')
  })

  describe('the re-plan arm (M40)', () => {
    /** A prompt with the one literal `REPLAN_INSTRUCTIONS` always carries. */
    const PROMPT = 'The GOAL changed and this is a "replan": return {"add":[],"cancel":[],"keep":[]}'
    const ADDED = '"key":"docs"'

    let repoDir: string

    beforeEach(() => {
      repoDir = mkdtempSync(path.join(tmpdir(), 'fake-claude-replan-'))
      execFileSync('git', ['init', '-q'], { cwd: repoDir })
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], {
        cwd: repoDir,
      })
    })

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true })
    })

    it('replays the delta fixture as a static mode, with an empty cancel array and no id to put in it', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'replan-delta'])
      const result = parseLines(stdout).find((l) => l.type === 'result') as
        | { result?: string; total_cost_usd?: number }
        | undefined
      expect(result?.result).toContain(ADDED)
      expect(result?.total_cost_usd).toBe(0.03)
      // The placeholder is what the arm substitutes; the file itself still carries it.
      expect(result?.result).toContain('$CANCEL_ID')
    })

    it('substitutes --replan-cancel <id> into the delta, and makes no commit doing it', async (): Promise<void> => {
      const { stdout } = await run(
        'node',
        [FAKE, '--replan-cancel', 'task-to-drop', '--fixture', 'm8-flow', '-p', PROMPT],
        { cwd: repoDir },
      )
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"cancel":["task-to-drop"]')
      expect(result?.result).not.toContain('$CANCEL_ID')
      // A re-plan is a read, exactly as a first plan is: no commit, no file.
      expect(execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')).toHaveLength(1)
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString().trim()).toBe('')
    })

    it('leaves an EMPTY cancel array when no --replan-cancel is passed', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'm8-flow', '-p', PROMPT], { cwd: repoDir })
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"cancel":[]')
      expect(result?.result).not.toContain('$CANCEL_ID')
    })

    it('ignores a --replan-cancel whose value is another flag', async (): Promise<void> => {
      // The E6 idiom: `args.indexOf(...) + 1` is a flag, not an id, when the value was omitted.
      const { stdout } = await run('node', [FAKE, '--replan-cancel', '--fixture', 'm8-flow', '-p', PROMPT], {
        cwd: repoDir,
      })
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"cancel":[]')
    })

    it('is checked BEFORE the task-graph arm, so a re-plan is never answered with a first plan', async (): Promise<void> => {
      // The trailer a re-plan run carries names the first plan's literal nowhere -- but a prompt
      // that carried both must still reach the delta, because the re-plan arm is the more specific
      // one and the board would otherwise be rebuilt from a graph nobody asked for. Both modes that
      // carry a task-graph arm share this ordering (M40 adds the re-plan arm in front of it in
      // every such mode, `m41-flow` included), so both are pinned here.
      for (const fixtureName of ['m8-flow', 'm41-flow']) {
        const { stdout } = await run(
          'node',
          [FAKE, '--fixture', fixtureName, '-p', `${PROMPT} "task graph" "verdict"`],
          { cwd: repoDir },
        )
        const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
        expect(result?.result).toContain(ADDED)
        expect(result?.result).not.toContain('"key":"core"')
      }
    })

    it('leaves a supervisor decision prompt to the decision arms', async (): Promise<void> => {
      // Both decision arms stay in front of it: a decision call that happened to quote the word
      // is still a decision, and answering it with a delta would put a plan where a candidate
      // index belongs.
      const { stdout } = await run(
        'node',
        [FAKE, '--fixture', 'm8-flow', '-p', 'a "replan" question. Reply with {"candidateIndex": <0..3>, "rationale": "..."}'],
        { cwd: repoDir },
      )
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"candidateIndex":0')
    })
  })

  describe('m41-flow (M41: the whole story in one mode)', () => {
    /** The one line `runContext.ts`'s `task` section always renders (erratum E2): a work run's
     *  prompt carries `Task: <title>`, and its task's ID appears nowhere in it. */
    const CORE_TITLE = 'Write the feature core'
    const CORE_PROMPT = `You are a slave.\n\nTask: ${CORE_TITLE}\n\nImplement the core module the goal asks for.`
    const API_PROMPT = 'You are a slave.\n\nTask: Expose the API\n\nWire the core into the public surface.'
    const ASK_JSON = JSON.stringify({ role: 'qa', question: 'Which database should this service connect to?' })

    let repoDir: string

    beforeEach(() => {
      repoDir = mkdtempSync(path.join(tmpdir(), 'fake-claude-m41-flow-'))
      execFileSync('git', ['init', '-q'], { cwd: repoDir })
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], {
        cwd: repoDir,
      })
    })

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true })
    })

    const commitCount = (): number =>
      execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n').length

    it('replays the story plan fixture as a static mode, quote and cost intact', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'plan-graph-scenario'])
      const result = parseLines(stdout).find((l) => l.type === 'result') as
        | { result?: string; total_cost_usd?: number }
        | undefined
      // The sentence `supervisor-answer.ndjson` cites. Without it in the asking task's own
      // description the Supervisor's answer could never be `sourced`, which is the whole of act 3.
      expect(result?.result).toContain('PostgreSQL on port 5433')
      expect(result?.result).toContain('"key":"core"')
      // Same cost as `plan-graph`, so the gate's spend table stays one lookup (ruling R4).
      expect(result?.total_cost_usd).toBe(0.20933900000000003)
    })

    it('a planning run replays plan-graph-scenario, NOT the stock plan-graph, and makes no commit', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'm41-flow', '-p', 'produce the "task graph" now'], {
        cwd: repoDir,
      })
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('PostgreSQL on port 5433')
      expect(commitCount()).toBe(1)
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString().trim()).toBe('')
    })

    it('a review run replays the approval fixture and makes no commit', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'm41-flow', '-p', 'respond with "verdict" json'], {
        cwd: repoDir,
      })
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"verdict":"approve"')
      expect(commitCount()).toBe(1)
    })

    it('a re-plan run replays the delta with --replan-cancel substituted, and makes no commit', async (): Promise<void> => {
      const { stdout } = await run(
        'node',
        [FAKE, '--replan-cancel', 'task-to-drop', '--fixture', 'm41-flow', '-p', 'this is a "replan"'],
        { cwd: repoDir },
      )
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"cancel":["task-to-drop"]')
      expect(result?.result).toContain('"key":"docs"')
      expect(commitCount()).toBe(1)
    })

    it('the asking leg fires only for the named task: ask block in, no commit', async (): Promise<void> => {
      const { stdout } = await run(
        'node',
        [FAKE, '--ask-on-task', 'core', '--fixture', 'm41-flow', '-p', CORE_PROMPT],
        { cwd: repoDir, env: { ...process.env, FAKE_CLAUDE_ASK_JSON: ASK_JSON } },
      )
      // The envelope is appended to the LAST assistant text block, not emitted as a line of its
      // own, so the pump reads it through the exact stream shape a real run produces.
      expect(stdout).toContain('<slave-ask>')
      // The envelope itself -- the ask JSON as it is escaped inside the text block, which is the
      // only place the pump ever reads it from.
      expect(stdout).toContain(JSON.stringify(`<slave-ask>\n${ASK_JSON}\n</slave-ask>`).slice(1, -1))
      // An ask is not work: the run stopped to ask, so it left nothing behind.
      expect(commitCount()).toBe(1)
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString().trim()).toBe('')
    })

    it('a work run for ANOTHER task commits instead of asking, even with --ask-on-task set', async (): Promise<void> => {
      // `API_PROMPT`'s description deliberately contains the token `core` ("Wire the core into the
      // public surface.") even though its title is `Expose the API`: a whole-prompt
      // `prompt.includes(token)` match would wrongly turn THIS run into the asking leg. This case
      // is the line-scoped guard -- the token has to be matched inside the `Task: <title>` line,
      // not anywhere in the prompt.
      const { stdout } = await run(
        'node',
        [FAKE, '--ask-on-task', 'core', '--fixture', 'm41-flow', '-p', API_PROMPT],
        { cwd: repoDir, env: { ...process.env, FAKE_CLAUDE_ASK_JSON: ASK_JSON } },
      )
      expect(stdout).not.toContain('<slave-ask>')
      expect(commitCount()).toBe(2)
      expect(readFileSync(path.join(repoDir, 'm41-work.txt'), 'utf8')).toContain('You are a slave.')
    })

    it('the RESUMED leg of the very same task commits instead of asking again', async (): Promise<void> => {
      const { stdout } = await run(
        'node',
        [FAKE, '--ask-on-task', 'core', '--fixture', 'm41-flow', '-p', CORE_PROMPT, '--resume', 'fake-session-complete'],
        { cwd: repoDir, env: { ...process.env, FAKE_CLAUDE_ASK_JSON: ASK_JSON } },
      )
      // `--resume` is the ONE thing the runtime itself puts on a resumed argv
      // (`ClaudeCodeAdapter.resume`), so a second ask on the same session is impossible by
      // construction rather than by wording.
      expect(stdout).not.toContain('<slave-ask>')
      expect(commitCount()).toBe(2)
    })

    it('a work run with no --ask-on-task at all commits', async (): Promise<void> => {
      await run('node', [FAKE, '--fixture', 'm41-flow', '-p', CORE_PROMPT], { cwd: repoDir })
      expect(commitCount()).toBe(2)
    })

    it('ignores an --ask-on-task whose value is another flag', async (): Promise<void> => {
      await run('node', [FAKE, '--ask-on-task', '--fixture', 'm41-flow', '-p', CORE_PROMPT], { cwd: repoDir })
      expect(commitCount()).toBe(2)
    })

    it('refuses the asking leg with no envelope in the environment, rather than asking nothing', async (): Promise<void> => {
      const env = { ...process.env }
      delete env.FAKE_CLAUDE_ASK_JSON
      await expect(
        run('node', [FAKE, '--ask-on-task', 'core', '--fixture', 'm41-flow', '-p', CORE_PROMPT], {
          cwd: repoDir,
          env,
        }),
      ).rejects.toMatchObject({ code: 2 })
    })
  })

  describe('the supervisor arm (M38)', () => {
    const ANSWER = '"candidateIndex":0'
    /** A prompt with the one literal `buildDecisionPrompt` always emits. */
    const PROMPT = 'CANDIDATE ACTIONS\n0. unblock_task\n\nReply with {"candidateIndex": <0..3>, "rationale": "..."}'

    let repoDir: string

    beforeEach(() => {
      repoDir = mkdtempSync(path.join(tmpdir(), 'fake-claude-supervisor-'))
      execFileSync('git', ['init', '-q'], { cwd: repoDir })
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], {
        cwd: repoDir,
      })
    })

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true })
    })

    it('replays the supervisor fixture as a static mode', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'supervisor-decision'])
      const result = parseLines(stdout).find((l) => l.type === 'result') as
        | { result?: string; total_cost_usd?: number }
        | undefined
      expect(result?.result).toContain(ANSWER)
      expect(result?.total_cost_usd).toBe(0.01)
    })

    it('answers a decision prompt inside a flow mode, and makes no commit doing it', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'm8a-flow', '-p', PROMPT], { cwd: repoDir })

      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain(ANSWER)
      // A work run would have left one; a decision is a read, and the arm must not fall through to
      // the work body.
      expect(execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')).toHaveLength(1)
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString().trim()).toBe('')
    })

    it('reads the prompt off STDIN, which is where a real decision call puts it', async (): Promise<void> => {
      // Exactly how `decideWithModel` spawns: extra args first, then a BARE `-p` with the prompt
      // on stdin. Nothing in argv carries it, so a mode that only sniffed argv would fall through
      // to the work body and commit in the gate's worktree.
      const stdout = execFileSync(
        'node',
        [FAKE, '--fixture', 'm8a-flow', '-p', '--restricted', '--no-session-persistence', '--tools', ''],
        { cwd: repoDir, input: PROMPT, encoding: 'utf8' },
      )
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain(ANSWER)
      expect(execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')).toHaveLength(1)
    })

    it('is armed in every prompt-sniffing mode, ahead of the verdict and task-graph checks', async (): Promise<void> => {
      for (const mode of ['m8-flow', 'm8a-flow', 'm36-flow', 'm41-flow']) {
        const { stdout } = await run('node', [FAKE, '--fixture', mode, '-p', `${PROMPT} "verdict" "task graph"`], {
          cwd: repoDir,
        })
        const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
        expect(result?.result, mode).toContain(ANSWER)
      }
    })
  })

  describe('the answer arm (M39)', () => {
    /** A prompt with the one literal `buildAnswerPrompt` always carries. */
    const PROMPT = 'Reply with {"answer": "...", "sources": [{"kind": "task", "ref": null, "quote": "..."}], "critical": false}'
    const SOURCED = '"quote":"PostgreSQL on port 5433"'
    const UNSOURCED = '"quote":"this sentence appears nowhere"'

    let repoDir: string

    beforeEach(() => {
      repoDir = mkdtempSync(path.join(tmpdir(), 'fake-claude-answer-'))
      execFileSync('git', ['init', '-q'], { cwd: repoDir })
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], {
        cwd: repoDir,
      })
    })

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true })
    })

    it('replays both answer fixtures as static modes, with the cost a second call adds', async (): Promise<void> => {
      for (const [name, quote] of [
        ['supervisor-answer', SOURCED],
        ['supervisor-answer-unsourced', UNSOURCED],
      ] as const) {
        const { stdout } = await run('node', [FAKE, '--fixture', name])
        const result = parseLines(stdout).find((l) => l.type === 'result') as
          | { result?: string; total_cost_usd?: number }
          | undefined
        expect(result?.result, name).toContain(quote)
        expect(result?.total_cost_usd, name).toBe(0.02)
      }
    })

    it('is armed in every prompt-sniffing mode, and makes no commit doing it', async (): Promise<void> => {
      for (const mode of ['m8-flow', 'm8a-flow', 'm36-flow', 'm41-flow']) {
        const { stdout } = await run('node', [FAKE, '--fixture', mode, '-p', `${PROMPT} "verdict" "task graph"`], {
          cwd: repoDir,
        })
        const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
        expect(result?.result, mode).toContain(SOURCED)
      }
      // An answer call is a read. A work run would have left a commit behind in the gate's worktree.
      expect(execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')).toHaveLength(1)
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString().trim()).toBe('')
    })

    it('replays the fixture FAKE_CLAUDE_ANSWER_FIXTURE names, which is how a gate chooses unsourced', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'm36-flow', '-p', PROMPT], {
        cwd: repoDir,
        env: { ...process.env, FAKE_CLAUDE_ANSWER_FIXTURE: 'supervisor-answer-unsourced' },
      })
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain(UNSOURCED)
    })

    it('replays the fixture --answer-fixture names, which is how a GATE chooses unsourced', async (): Promise<void> => {
      // Argv, not the environment (erratum E6): a decision call's child is spawned with
      // `buildDecisionEnv()` -- PATH, HOME, LANG, TERM and nothing else (M31a §4 ruling R1) -- so
      // `FAKE_CLAUDE_ANSWER_FIXTURE` set on a daemon never reaches this script, while
      // `SLAVEOFAI_CLAUDE_ARGS` rides through as `extraArgs` exactly as `--fixture` does. The flag
      // is placed BEFORE the mode's own flags, which is where `decisionArgs` puts extra args.
      const { stdout } = await run(
        'node',
        [FAKE, '--answer-fixture', 'supervisor-answer-unsourced', '--fixture', 'm36-flow', '-p', PROMPT],
        { cwd: repoDir },
      )
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain(UNSOURCED)
    })

    it('prefers the flag over the environment when a caller sets both', async (): Promise<void> => {
      const { stdout } = await run(
        'node',
        [FAKE, '--answer-fixture', 'supervisor-answer', '--fixture', 'm36-flow', '-p', PROMPT],
        { cwd: repoDir, env: { ...process.env, FAKE_CLAUDE_ANSWER_FIXTURE: 'supervisor-answer-unsourced' } },
      )
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain(SOURCED)
    })

    it('reads the prompt off STDIN, which is where a real answer call puts it', async (): Promise<void> => {
      const stdout = execFileSync(
        'node',
        [FAKE, '--fixture', 'm8a-flow', '-p', '--restricted', '--no-session-persistence', '--tools', ''],
        { cwd: repoDir, input: PROMPT, encoding: 'utf8' },
      )
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain(SOURCED)
    })

    it('leaves a choose-a-candidate prompt to the supervisor arm', async (): Promise<void> => {
      // The two decision arms sit next to each other; the choose prompt carries no `"sources"`, so
      // it must still reach `supervisor-decision` with the answer arm in front of nothing.
      const { stdout } = await run('node', [
        FAKE,
        '--fixture',
        'm36-flow',
        '-p',
        'Reply with {"candidateIndex": <0..3>, "rationale": "..."}',
      ], { cwd: repoDir })
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"candidateIndex":0')
    })
  })

  describe('m8-flow', () => {
    let repoDir: string

    beforeEach(() => {
      repoDir = mkdtempSync(path.join(tmpdir(), 'fake-claude-m8-flow-'))
      execFileSync('git', ['init', '-q'], { cwd: repoDir })
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], {
        cwd: repoDir,
      })
    })

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true })
    })

    it('a planning run (prompt containing "task graph") replays plan-graph, makes no commit, and writes no file', async (): Promise<void> => {
      const before = execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')
      expect(before.length).toBe(1)

      const { stdout } = await run('node', [FAKE, '--fixture', 'm8-flow', '-p', 'produce the "task graph" now'], {
        cwd: repoDir,
      })

      const after = execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')
      expect(after.length).toBe(1)
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString().trim()
      expect(status).toBe('')

      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"key":"core"')
    })

    it('a review run (prompt containing "verdict") replays the approval fixture', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'm8-flow', '-p', 'respond with "verdict" json'], {
        cwd: repoDir,
      })
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"verdict":"approve"')
    })

    it('a work run leaves a real commit in the worktree and replays the complete fixture', async (): Promise<void> => {
      const before = execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')
      expect(before.length).toBe(1)

      await run('node', [FAKE, '--fixture', 'm8-flow', '-p', 'work on it'], { cwd: repoDir })

      const after = execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')
      expect(after.length).toBe(2)
    })
  })

  describe('m8a-flow', () => {
    let repoDir: string

    beforeEach(() => {
      repoDir = mkdtempSync(path.join(tmpdir(), 'fake-claude-m8a-flow-'))
      execFileSync('git', ['init', '-q'], { cwd: repoDir })
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], {
        cwd: repoDir,
      })
    })

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true })
    })

    it('a work run leaves a real commit in the worktree and replays the complete fixture', async (): Promise<void> => {
      const before = execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')
      expect(before.length).toBe(1)

      const { stdout } = await run('node', [FAKE, '--fixture', 'm8a-flow', '-p', 'work on it'], { cwd: repoDir })

      const after = execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')
      expect(after.length).toBe(2)

      const completeFixture = await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(FIXTURES_DIR, 'complete.ndjson'), 'utf8'),
      )
      const expectedResultLine = completeFixture.trim().split('\n').find((l) => JSON.parse(l).type === 'result')
      expect(expectedResultLine).toBeDefined()
      expect(stdout).toContain(expectedResultLine as string)
    })

    it('a review run (prompt containing "verdict") replays the approval fixture and makes no commit', async (): Promise<void> => {
      const before = execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')
      expect(before.length).toBe(1)

      const { stdout } = await run('node', [FAKE, '--fixture', 'm8a-flow', '-p', 'respond with "verdict" json'], {
        cwd: repoDir,
      })

      const after = execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n')
      expect(after.length).toBe(1)
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"verdict":"approve"')
    })
  })
})
