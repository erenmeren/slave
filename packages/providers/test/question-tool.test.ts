import { PROVIDER_KINDS } from '@slave-of-ai/domain'
import { describe, expect, it } from 'vitest'
import { parseCursorLine } from '../src/cursor/stream.js'
import { isUserQuestionTool, USER_QUESTION_TOOLS } from '../src/question-tool.js'

describe('USER_QUESTION_TOOLS (H9 F6)', () => {
  it('names one ask-the-user tool for every provider', () => {
    for (const kind of PROVIDER_KINDS) expect(USER_QUESTION_TOOLS[kind].length).toBeGreaterThan(0)
    expect(isUserQuestionTool('cursor', 'askQuestion')).toBe(true)
    expect(isUserQuestionTool('claude_code', 'AskUserQuestion')).toBe(true)
  })

  it("is keyed on the provider: one vendor's tool name is nothing on the other", () => {
    expect(isUserQuestionTool('claude_code', 'askQuestion')).toBe(false)
    expect(isUserQuestionTool('cursor', 'AskUserQuestion')).toBe(false)
    expect(isUserQuestionTool('cursor', 'shell')).toBe(false)
  })

  it('matches the name a refused Cursor askQuestion call actually parses to', () => {
    // The shape of the 2026-09-21 refusal: the tool is the KEY of `tool_call` (`askQuestionToolCall`)
    // and the completed half carries `result.rejected`. No reason text is asserted -- the CLI
    // self-updates and its wording is not this system's to pin.
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'call_q1',
      tool_call: { askQuestionToolCall: { args: { question: 'Which port?' }, result: { rejected: {} } } },
    })
    const event = parseCursorLine(line)
    expect(event.kind).toBe('permission_denied')
    if (event.kind !== 'permission_denied') throw new Error('expected permission_denied')
    expect(isUserQuestionTool('cursor', event.toolName)).toBe(true)
  })
})
