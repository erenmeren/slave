import { describe, expect, it } from 'vitest'
import { cursorFlags } from '../src/cursor/flags.js'

/**
 * Every flag asserted here was read off `cursor-agent --help` (binary
 * 2026.08.11-e8db854, 2026-08-26) rather than off the plan; the verified table
 * and the help text's own words are in the Task 11 report.
 */
describe('cursorFlags', () => {
  it('always streams structured output', () => {
    expect(cursorFlags()).toContain('--output-format')
    expect(cursorFlags()).toContain('stream-json')
  })

  // `--output-format` "only works with --print" (help text), and without
  // `--print` the slave runs interactively and the stream parser is handed
  // nothing it can read.
  it('always prints, because --output-format only works with --print', () => {
    expect(cursorFlags()).toContain('--print')
  })

  // Task 10 measured this: in a directory the user has not already trusted --
  // which every fresh worktree is -- `cursor-agent` exits 1 with a completely
  // empty stdout and the explanation on stderr only.
  it('always trusts the workspace, because its absence is invisible on stdout', () => {
    expect(cursorFlags()).toContain('--trust')
  })

  it('always forces, which is what keeps a hook deny the only thing that stops a command', () => {
    expect(cursorFlags()).toContain('--force')
  })

  it('passes a resolved model and omits the flag entirely when there is none', () => {
    expect(cursorFlags({ model: 'm' })).toContain('--model')
    expect(cursorFlags()).not.toContain('--model')
  })

  it('puts the model value immediately after --model', () => {
    const flags = cursorFlags({ model: 'sonnet-4-thinking' })
    expect(flags[flags.indexOf('--model') + 1]).toBe('sonnet-4-thinking')
  })

  it('continues a session by id on resume', () => {
    expect(cursorFlags({ resume: { sessionId: 's-1' } }).join(' ')).toContain('--resume s-1')
  })

  it('omits --resume entirely when there is no session to resume', () => {
    expect(cursorFlags()).not.toContain('--resume')
  })

  // R2. `--resume [chatId]` takes an OPTIONAL argument and the prompt is a
  // POSITIONAL argument, so a bare `--resume` swallows the prompt as a chat id
  // and leaves the run with no prompt at all. The failure is silent, so an
  // unusable session id must be rejected before a process exists -- the same
  // guard, for the same reason, as `claudeFlags` rejecting a relative
  // `settingsPath`.
  it.each(['', ' ', '\t', '\n', '   \n '])(
    'refuses to emit --resume with the unusable session id %j',
    (sessionId) => {
      expect(() => cursorFlags({ resume: { sessionId } })).toThrow(/sessionId/)
    },
  )

  it.each(['', ' ', '\n'])('refuses to emit --model with the unusable model %j', (model) => {
    expect(() => cursorFlags({ model })).toThrow(/model/)
  })

  // One assertion per flag, deliberately, so a future edit that adds any one of
  // them fails on its own line and names itself. The reasons are in
  // `cursor/flags.ts`'s NEVER-PASS block.
  describe('the never-pass list', () => {
    const inputs = [
      {},
      { model: 'm' },
      { resume: { sessionId: 's-1' } },
      { model: 'm', resume: { sessionId: 's-1' } },
    ] as const

    it.each(['-w', '--worktree', '--stream-partial-output', '--yolo', '--plan', '--mode'])(
      'never emits %s',
      (flag) => {
        for (const input of inputs) {
          expect(cursorFlags(input)).not.toContain(flag)
        }
      },
    )
  })

  it('is pure: the same input yields the same flags every time', () => {
    expect(cursorFlags({ model: 'm', resume: { sessionId: 's-1' } })).toEqual(
      cursorFlags({ model: 'm', resume: { sessionId: 's-1' } }),
    )
  })
})
