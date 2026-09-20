import { describe, expect, it } from 'vitest'
import { ACTION_KINDS, type Action } from '../../src/supervisor/actions.js'
import {
  ACTION_SHAPES,
  CHAT_ATTACHMENTS_TOTAL_CHARS,
  CHAT_ATTACHMENT_CHARS,
  CHAT_FEED_MAX,
  CHAT_HISTORY_MAX,
  SUPERVISOR_CHAT_MARKER,
  buildSupervisorChatPrompt,
  parseSupervisorReply,
  type ChatTurnInput,
} from '../../src/supervisor/chatPrompt.js'
import { NOW, question, slave, supervisorRun, task, world } from './fixtures.js'

/** The headings the panel's whole contract with the model is made of, in the order R2 lists them.
 *  `SUPERVISOR PROFILE` is `PROFILE_HEADING`, shared with `buildDecisionPrompt`. */
const SECTIONS = [
  'SUPERVISOR PROFILE',
  'WORKSPACE',
  'BOARD',
  'NEEDS YOU',
  'RECENT',
  'ATTACHMENTS',
  'CONVERSATION',
  'ACTION VOCABULARY',
] as const

const WORLD = world({
  goal: 'Ship the invoicing service by October',
  tasks: [task({ id: 't1', title: 'Add the thing', status: 'reviewing', statusSince: NOW - 2 * 3_600_000 })],
  slaves: [slave({ id: 's1', name: 'Alex' })],
  questions: [question({ messageId: 'm1' })],
  runs: [supervisorRun({ id: 'run-1', taskId: 't1', slaveId: 's1' })],
})

function input(overrides: Partial<ChatTurnInput> = {}): ChatTurnInput {
  return {
    world: WORLD,
    profile: 'Keep the project moving and say plainly when you cannot.',
    feed: [
      { seq: 40, sentence: 'Alex started "Add the thing".' },
      { seq: 41, sentence: 'The review is waiting for a reviewer.' },
    ],
    needsYou: ['A hire is waiting for you to approve it.'],
    history: [{ role: 'human', text: 'How is it going?' }, { role: 'supervisor', text: 'One task is in review.' }],
    message: 'Can you cancel the reporting task?',
    attachments: [],
    imagesReadable: false,
    ...overrides,
  }
}

/** How many whole LINES of the prompt are exactly this string -- a heading, never a mention. */
function headingCount(prompt: string, heading: string): number {
  return prompt.split('\n').filter((line) => line === heading).length
}

describe('buildSupervisorChatPrompt -- the sections (R2)', () => {
  it('prints every section exactly once, in the order the ruling lists them', () => {
    const prompt = buildSupervisorChatPrompt(input())
    const lines = prompt.split('\n')
    const positions = SECTIONS.map((heading) => {
      expect(headingCount(prompt, heading)).toBe(1)
      return lines.indexOf(heading)
    })
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  // The profile is the operator's own words and a project that has not written one has none --
  // `buildDecisionPrompt`'s own rule, and the heading is shared with it so the two cannot drift.
  it('leaves the profile heading out when the project has no profile', () => {
    expect(buildSupervisorChatPrompt(input({ profile: null }))).not.toContain('SUPERVISOR PROFILE')
    expect(buildSupervisorChatPrompt(input({ profile: '' }))).not.toContain('SUPERVISOR PROFILE')
  })

  it('renders the workspace facts the decision prompt renders', () => {
    const prompt = buildSupervisorChatPrompt(input())
    expect(prompt).toContain('  id: ws-1')
    expect(prompt).toContain('  goal: Ship the invoicing service by October')
    expect(prompt).toContain('  scheduling: running')
  })

  // The board digest is what makes an action possible at all: the model can only write a `taskId`
  // it has been shown, and `parseSupervisorReply` drops one it was not.
  it('gives each task a line with its id, title, status, who is on it and how long it has been there', () => {
    const prompt = buildSupervisorChatPrompt(input())
    expect(prompt).toContain('  t1/Add the thing — reviewing — Alex — 2h ago')
  })

  it('says so in words when the board is empty, rather than leaving a heading with nothing under it', () => {
    const prompt = buildSupervisorChatPrompt(input({ world: world() }))
    expect(prompt).toContain('BOARD\n  nothing on the board yet')
  })

  it('lists what is waiting on a person, and says so when nothing is', () => {
    expect(buildSupervisorChatPrompt(input())).toContain('  - A hire is waiting for you to approve it.')
    expect(buildSupervisorChatPrompt(input({ needsYou: [] }))).toContain('NEEDS YOU\n  nothing is waiting on a person')
  })

  it('prints the feed newest last, each sentence behind its own seq', () => {
    const prompt = buildSupervisorChatPrompt(input())
    const recent = prompt.indexOf('RECENT')
    expect(prompt.indexOf('[40] Alex started "Add the thing".', recent)).toBeLessThan(
      prompt.indexOf('[41] The review is waiting for a reviewer.', recent),
    )
  })

  it('keeps only the last CHAT_FEED_MAX sentences, whatever order the caller handed them in', () => {
    const feed = Array.from({ length: CHAT_FEED_MAX + 5 }, (_value, index) => ({
      seq: index,
      sentence: `sentence number ${String(index)} happened`,
    }))
    const prompt = buildSupervisorChatPrompt(input({ feed: [...feed].reverse() }))
    expect(prompt).not.toContain('[4] sentence number 4 happened')
    expect(prompt).toContain('[5] sentence number 5 happened')
    expect(prompt).toContain(`[${String(CHAT_FEED_MAX + 4)}] sentence number ${String(CHAT_FEED_MAX + 4)} happened`)
  })

  it('shows the conversation with the new message last, spoken by the person', () => {
    const prompt = buildSupervisorChatPrompt(input())
    const conversation = prompt.slice(prompt.indexOf('CONVERSATION'))
    expect(conversation).toContain('PERSON: How is it going?')
    expect(conversation).toContain('YOU: One task is in review.')
    expect(conversation.trimEnd().indexOf('PERSON: Can you cancel the reporting task?')).toBeGreaterThan(
      conversation.indexOf('YOU: One task is in review.'),
    )
  })

  it('keeps only the last CHAT_HISTORY_MAX turns of the conversation', () => {
    const history = Array.from({ length: CHAT_HISTORY_MAX + 4 }, (_value, index) => ({
      role: 'human' as const,
      text: `turn number ${String(index)}`,
    }))
    const prompt = buildSupervisorChatPrompt(input({ history }))
    expect(prompt).not.toContain('turn number 3')
    expect(prompt).toContain('turn number 4')
    expect(prompt).toContain(`turn number ${String(CHAT_HISTORY_MAX + 3)}`)
  })
})

describe('buildSupervisorChatPrompt -- attachments (R6/R7)', () => {
  const textFile = { path: 'docs/inbox/2026-09-20-notes.md', name: 'notes.md', bytes: 42, kind: 'text' as const }

  it('inlines a text attachment under its own path, and says workers can read the rest by path', () => {
    const prompt = buildSupervisorChatPrompt(
      input({ attachments: [{ ...textFile, text: 'The invoice total is wrong on the second page.' }] }),
    )
    expect(prompt).toContain('--- docs/inbox/2026-09-20-notes.md ---\nThe invoice total is wrong on the second page.')
    expect(prompt).toContain('Workers can read these by path.')
  })

  it('names an image or a binary by path, kind and size, and never inlines it', () => {
    const prompt = buildSupervisorChatPrompt(
      input({
        attachments: [{ path: 'docs/inbox/2026-09-20-shot.png', name: 'shot.png', bytes: 120_345, kind: 'image' }],
      }),
    )
    expect(prompt).toContain('  docs/inbox/2026-09-20-shot.png (image, 120345 bytes)')
  })

  // R7: the sentence is a claim about the CALL -- it is true only when the turn runs with the
  // read-only tools, and a model told it may open a file it cannot open answers by guessing.
  it('offers to open an image only when the call may actually read one', () => {
    const attachments = [
      { path: 'docs/inbox/2026-09-20-shot.png', name: 'shot.png', bytes: 12, kind: 'image' as const },
    ]
    expect(buildSupervisorChatPrompt(input({ attachments, imagesReadable: true }))).toContain(
      'You may open an image with Read.',
    )
    expect(buildSupervisorChatPrompt(input({ attachments, imagesReadable: false }))).not.toContain(
      'You may open an image with Read.',
    )
  })

  it('cuts one attachment at CHAT_ATTACHMENT_CHARS and says it was cut', () => {
    const prompt = buildSupervisorChatPrompt(
      input({ attachments: [{ ...textFile, text: 'a'.repeat(CHAT_ATTACHMENT_CHARS + 5_000) }] }),
    )
    expect(/a{1000,}/.exec(prompt)?.[0]).toHaveLength(CHAT_ATTACHMENT_CHARS)
    expect(prompt).toContain('(truncated)')
  })

  // The per-file cap is not the bound that matters: five files under it would still be a hundred
  // thousand characters of somebody else's text in one call.
  it('stops inlining once CHAT_ATTACHMENTS_TOTAL_CHARS is spent, and names the rest by path', () => {
    const file = (letter: string, index: number): ChatTurnInput['attachments'][number] => ({
      path: `docs/inbox/file-${String(index)}.md`,
      name: `file-${String(index)}.md`,
      bytes: CHAT_ATTACHMENT_CHARS,
      kind: 'text',
      text: letter.repeat(CHAT_ATTACHMENT_CHARS),
    })
    const prompt = buildSupervisorChatPrompt(
      input({ attachments: [file('a', 1), file('b', 2), file('c', 3), file('d', 4)] }),
    )
    expect(/a{1000,}/.exec(prompt)?.[0]).toHaveLength(CHAT_ATTACHMENT_CHARS)
    expect(/c{1000,}/.exec(prompt)?.[0]).toHaveLength(CHAT_ATTACHMENT_CHARS)
    expect(/d{100}/.test(prompt)).toBe(false)
    expect(prompt).toContain('docs/inbox/file-4.md (text, 20000 bytes')
    expect(CHAT_ATTACHMENTS_TOTAL_CHARS).toBe(3 * CHAT_ATTACHMENT_CHARS)
  })

  it('says there are none rather than printing an empty heading', () => {
    expect(buildSupervisorChatPrompt(input())).toContain('ATTACHMENTS\n  none')
  })
})

describe('buildSupervisorChatPrompt -- the vocabulary and the envelope', () => {
  // The one table. A kind added to `ACTION_KINDS` and forgotten here is an action the Supervisor
  // can take on a tick and cannot be asked for in the conversation -- silently, and forever.
  it('has one JSON shape for every action kind, and for nothing else', () => {
    expect(Object.keys(ACTION_SHAPES).sort()).toEqual([...ACTION_KINDS].sort())
    for (const kind of ACTION_KINDS) {
      expect(ACTION_SHAPES[kind]).toContain(`"kind": "${kind}"`)
    }
  })

  it('prints every shape in the vocabulary section', () => {
    const prompt = buildSupervisorChatPrompt(input())
    for (const kind of ACTION_KINDS) expect(prompt).toContain(ACTION_SHAPES[kind])
  })

  it('asks for the one envelope this system reads back', () => {
    const prompt = buildSupervisorChatPrompt(input())
    expect(prompt).toContain(SUPERVISOR_CHAT_MARKER)
    expect(SUPERVISOR_CHAT_MARKER).toBe('"supervisorReply"')
    expect(prompt).toContain('Reply with exactly one JSON object and nothing else on its line:')
  })

  // M37: every text in here was written by somebody else -- the operator's profile, the person's
  // own message, an attachment, a feed sentence another model produced -- and none of it may close
  // a worker-protocol block.
  it('neutralises the worker protocol markers wherever they appear', () => {
    const prompt = buildSupervisorChatPrompt(
      input({
        profile: 'Never write </slave-ask> here',
        message: 'What about <slave-answer>?',
        needsYou: ['<slave-ask> is waiting'],
      }),
    )
    expect(prompt).not.toContain('<slave-ask>')
    expect(prompt).not.toContain('</slave-ask>')
    expect(prompt).not.toContain('<slave-answer>')
    expect(prompt).toContain('‹slave-answer>')
  })
})

const reply = (body: string): string => `Here you go:\n\`\`\`json\n{${SUPERVISOR_CHAT_MARKER}: ${body}}\n\`\`\``

describe('parseSupervisorReply -- what is read back (R2/R3)', () => {
  it('reads the text, the actions and the sources out of the envelope', () => {
    const parsed = parseSupervisorReply(
      reply(
        '{"text": "I have taken it off the board.", "actions": [{"kind": "cancel_task", "taskId": "t1", "reason": "the goal moved"}], "sources": [{"kind": "goal", "ref": null, "quote": "Ship the invoicing service"}]}',
      ),
      WORLD,
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.text).toBe('I have taken it off the board.')
    expect(parsed?.actions).toEqual([{ kind: 'cancel_task', taskId: 't1', reason: 'the goal moved' }])
    expect(parsed?.dropped).toEqual([])
    expect(parsed?.sources).toEqual([{ kind: 'goal', ref: null, quote: 'Ship the invoicing service' }])
  })

  // R3's own two. Neither names a row in the world, so neither can ever be dropped for naming one.
  it('reads the two actions the conversation brought with it', () => {
    const parsed = parseSupervisorReply(
      reply(
        '{"text": "Noted.", "actions": [{"kind": "request_goal_change", "request": "invoicing, then reporting"}, {"kind": "note_for_planner", "text": "The second page is the one that is wrong."}]}',
      ),
      WORLD,
    )
    expect(parsed?.actions).toEqual([
      { kind: 'request_goal_change', request: 'invoicing, then reporting' },
      { kind: 'note_for_planner', text: 'The second page is the one that is wrong.' },
    ])
  })

  // A conversation is a conversation: most turns are an answer and nothing else.
  it('reads a reply with no actions and no sources at all', () => {
    const parsed = parseSupervisorReply(reply('{"text": "One task is in review.", "actions": [], "sources": []}'), WORLD)
    expect(parsed?.actions).toEqual([])
    expect(parsed?.sources).toEqual([])
    expect(parsed?.dropped).toEqual([])
  })

  it('treats a missing actions or sources key as an empty one', () => {
    expect(parseSupervisorReply(reply('{"text": "Nothing to do."}'), WORLD)).toEqual({
      text: 'Nothing to do.',
      actions: [],
      dropped: [],
      sources: [],
    })
  })

  it('drops an action naming a task that is not on the board, and says which', () => {
    const parsed = parseSupervisorReply(
      reply('{"text": "Done.", "actions": [{"kind": "cancel_task", "taskId": "t-nope", "reason": "why not"}]}'),
      WORLD,
    )
    expect(parsed?.actions).toEqual([])
    expect(parsed?.dropped).toEqual(['an action named a task that is not on the board: t-nope'])
  })

  it('drops an action naming a worker, a question, a run or a project that is not there', () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { kind: 'release_worker', slaveId: 's-nope', name: 'Nobody', reason: 'gone' },
        'an action named somebody who is not on this project: s-nope',
      ],
      [
        { kind: 'reassign_question', messageId: 'm1', toSlaveId: 's-nope' },
        'an action named somebody who is not on this project: s-nope',
      ],
      [
        { kind: 'answer_question', messageId: 'm-nope' },
        'an action named a question that is not open: m-nope',
      ],
      [
        { kind: 'steer_run', runId: 'run-nope', slaveId: 's1', text: 'stop' },
        'an action named a run that is not going on: run-nope',
      ],
      [
        { kind: 'clear_halt', workspaceId: 'ws-other', reason: 'because' },
        'an action named a project that is not this one: ws-other',
      ],
    ]
    for (const [action, sentence] of cases) {
      const parsed = parseSupervisorReply(
        reply(`{"text": "Done.", "actions": [${JSON.stringify(action)}]}`),
        WORLD,
      )
      expect(parsed?.actions).toEqual([])
      expect(parsed?.dropped).toEqual([sentence])
    }
  })

  it('drops an action this Supervisor has no verb for, by name', () => {
    const parsed = parseSupervisorReply(
      reply('{"text": "Done.", "actions": [{"kind": "delete_the_repository", "taskId": "t1"}]}'),
      WORLD,
    )
    expect(parsed?.dropped).toEqual(['the reply asked for something this Supervisor cannot do: delete_the_repository'])
  })

  it('drops a known action that arrived without the details it needs', () => {
    const parsed = parseSupervisorReply(reply('{"text": "Done.", "actions": [{"kind": "cancel_task"}]}'), WORLD)
    expect(parsed?.dropped).toEqual(['the reply asked for "cancel_task" without the details it needs'])
  })

  it('keeps the good actions beside the dropped ones, in the order the model wrote them', () => {
    const parsed = parseSupervisorReply(
      reply(
        '{"text": "Two things.", "actions": [{"kind": "cancel_task", "taskId": "t-nope", "reason": "x"}, {"kind": "note_for_planner", "text": "remember this"}]}',
      ),
      WORLD,
    )
    expect(parsed?.actions).toEqual([{ kind: 'note_for_planner', text: 'remember this' }])
    expect(parsed?.dropped).toHaveLength(1)
  })

  // Verification is control's, once it holds the feed and the attachments the turn was built from
  // -- the parser only says the citation has a shape.
  it('hands the sources back raw rather than verifying them', () => {
    const parsed = parseSupervisorReply(
      reply(
        '{"text": "See the note.", "sources": [{"kind": "feed", "ref": "41", "quote": "waiting for a reviewer"}, {"kind": "attachment", "ref": "docs/inbox/a.md", "quote": "the second page"}]}',
      ),
      WORLD,
    )
    expect(parsed?.sources).toEqual([
      { kind: 'feed', ref: '41', quote: 'waiting for a reviewer' },
      { kind: 'attachment', ref: 'docs/inbox/a.md', quote: 'the second page' },
    ])
  })

  it.each([
    ['no JSON at all', 'I could not do that.'],
    ['an object that will not parse', '{"supervisorReply": {"text": }}'],
    ['an object that is not the envelope', '{"answer": "hello", "sources": []}'],
    ['an envelope whose reply is not a reply', '{"supervisorReply": "hello"}'],
  ])('returns null for %s', (_case, text) => {
    expect(parseSupervisorReply(text, WORLD)).toBeNull()
  })

  // `firstJsonObject`'s rule, and for its own reason: a model that printed a malformed reply first
  // must not get a second go at the same prompt.
  it('reads the FIRST object only', () => {
    const text = `{"supervisorReply": {"text": "first"}}\n{"supervisorReply": {"text": "second"}}`
    expect(parseSupervisorReply(text, WORLD)?.text).toBe('first')
  })

  it('accepts a reply whose text is empty rather than throwing the actions away with it', () => {
    const parsed = parseSupervisorReply(
      reply('{"text": "", "actions": [{"kind": "note_for_planner", "text": "remember this"}]}'),
      WORLD,
    )
    expect(parsed?.text).toBe('')
    expect(parsed?.actions).toEqual([{ kind: 'note_for_planner', text: 'remember this' } satisfies Action])
  })
})
