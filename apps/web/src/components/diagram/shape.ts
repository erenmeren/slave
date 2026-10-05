import type { BuildDiagram, DiagramNode, DiagramSession, DiagramState } from '@slave-of-ai/control'
import { formatUsd, plural } from '@/lib/format'
import { RESULT_WORD, STATE_WORD, toneOfResult, toneOfState, type Tone } from './words'

/** A helper called more often than this is drawn as one card with a count, opened to its sessions on demand. */
export const GROUP_OVER = 3

/** What one card of the diagram says. Plain data: the canvas draws it, the tests read it. */
export interface CardData {
  readonly kind: 'request' | 'lead' | 'helper' | 'session' | 'checker' | 'result'
  /** The diagram node the card stands for, and the one session of it when the card is a session's. */
  readonly nodeId: string
  readonly sessionId: string | null
  readonly name: string
  /** "lead", "helper · call 2 of 3", "checker". */
  readonly role: string
  readonly badge: string
  readonly tone: Tone
  readonly working: boolean
  /** What a helper session was asked to do; null on every other card. */
  readonly asked: string | null
  /** What it is doing now, or why it is not doing anything. */
  readonly sentence: string
  /** "58 steps", and beside it the failed ones and the cost; null on the request and the result. */
  readonly steps: string | null
  readonly failed: string | null
  readonly cost: string | null
  /** How many sessions a grouped helper's card stands for; null when the card is not a group. */
  readonly group: number | null
  readonly expanded: boolean
}

export interface CardSpec {
  readonly id: string
  readonly width: number
  readonly height: number
  readonly data: CardData
}

export interface LineSpec {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly label: string | null
  readonly tone: Tone
  /** Drawn dashed and moving: the target is working. */
  readonly moving: boolean
}

export interface DiagramShape {
  readonly cards: readonly CardSpec[]
  readonly lines: readonly LineSpec[]
}

/** The cards' boxes, as the layout is told them and the canvas draws them. */
export const CARD_SIZE = { person: { width: 240, height: 112 }, session: { width: 240, height: 132 }, end: { width: 216, height: 104 } } as const

const idle = (state: DiagramState): string => (state === 'paused' ? 'Paused until you press Continue' : state === 'failed' ? 'Stopped on a failure' : 'Not working now')
const sentenceOf = (state: DiagramState, doing: string | null): string => (state === 'working' ? (doing ?? 'Starting…') : idle(state))
const failedOf = (count: number): string | null => (count === 0 ? null : `${String(count)} failed`)

/** A person's cost in words: their own figure, or where it is. */
export function costOf(kind: DiagramNode['kind'], costUsd: number | null, open: boolean): string | null {
  if (kind === 'request' || kind === 'result') return null
  if (kind === 'helper') return "cost in the lead's"
  if (costUsd !== null) return open ? `${formatUsd(costUsd)} so far` : formatUsd(costUsd)
  return open ? 'cost when it ends' : 'cost not reported'
}

function personCard(node: DiagramNode, group: number | null, expanded: boolean): CardSpec {
  const tone = toneOfState(node.state, node.kind === 'checker')
  return {
    id: node.id,
    ...CARD_SIZE.person,
    data: {
      kind: node.kind,
      nodeId: node.id,
      sessionId: null,
      name: node.name,
      role: node.kind === 'lead' ? plural(node.sessions, 'turn') : node.kind === 'checker' ? plural(node.sessions, 'check') : `helper · ${plural(node.sessions, 'session')}`,
      badge: STATE_WORD[node.state],
      tone,
      working: node.state === 'working',
      asked: null,
      sentence: sentenceOf(node.state, node.doing),
      steps: plural(node.toolCalls, 'step'),
      failed: failedOf(node.failedCalls),
      cost: costOf(node.kind, node.costUsd, node.running > 0),
      group,
      expanded,
    },
  }
}

function sessionCard(node: DiagramNode, session: DiagramSession, index: number, of: number): CardSpec {
  return {
    id: `session:${session.id}`,
    ...CARD_SIZE.session,
    data: {
      kind: 'session',
      nodeId: node.id,
      sessionId: session.id,
      name: node.name,
      role: of === 1 ? 'helper' : `helper · call ${String(index + 1)} of ${String(of)}`,
      badge: STATE_WORD[session.state],
      tone: toneOfState(session.state, false),
      working: session.state === 'working',
      asked: session.label,
      sentence: sentenceOf(session.state, session.doing),
      steps: plural(session.toolCalls, 'step'),
      failed: failedOf(session.failedCalls),
      cost: costOf('helper', null, false),
      group: null,
      expanded: false,
    },
  }
}

/**
 * The team diagram's cards and lines, from a build: You, the lead, the helpers, the checkers and
 * the result. A helper called a few times is one card per session; called more than `GROUP_OVER`
 * times it is one card with its count, and its sessions hang off it once it is in `expanded`.
 * Pure: the same build and the same `expanded` give the same shape.
 */
export function diagramShape(build: BuildDiagram, expanded: ReadonlySet<string> = new Set()): DiagramShape {
  const cards: CardSpec[] = []
  const lines: LineSpec[] = []
  const nodeOf = new Map(build.nodes.map((node) => [node.id, node]))
  for (const node of build.nodes) {
    if (node.kind === 'request') {
      cards.push({ id: node.id, ...CARD_SIZE.end, data: { kind: 'request', nodeId: node.id, sessionId: null, name: node.name, role: `asked for build ${String(build.version)}`, badge: '', tone: 'muted', working: false, asked: null, sentence: build.goal === '' ? 'The request has no text.' : build.goal, steps: null, failed: null, cost: null, group: null, expanded: false } })
    } else if (node.kind === 'result') {
      const tone = toneOfResult(build.result)
      cards.push({ id: node.id, ...CARD_SIZE.end, data: { kind: 'result', nodeId: node.id, sessionId: null, name: node.name, role: `of build ${String(build.version)}`, badge: RESULT_WORD[build.result], tone, working: false, asked: null, sentence: RESULT_SENTENCE[build.result], steps: null, failed: null, cost: null, group: null, expanded: false } })
    } else if (node.kind === 'helper') {
      const sessions = build.sessions.filter((session) => session.nodeId === node.id)
      const grouped = sessions.length > GROUP_OVER
      const open = grouped && expanded.has(node.id)
      if (grouped || sessions.length === 0) cards.push(personCard(node, grouped ? sessions.length : null, open))
      if (!grouped || open) sessions.forEach((session, index) => cards.push(sessionCard(node, session, index, sessions.length)))
    } else {
      cards.push(personCard(node, null, false))
    }
  }

  for (const edge of build.edges) {
    const target = nodeOf.get(edge.target)
    const tone = edge.kind === 'result' ? toneOfResult(build.result) : toneOfState(edge.state, edge.kind === 'check')
    if (target?.kind !== 'helper') {
      lines.push({ id: edge.id, source: edge.source, target: edge.target, label: edge.label, tone, moving: edge.kind !== 'result' && edge.state === 'working' })
      continue
    }
    const sessions = build.sessions.filter((session) => session.nodeId === target.id)
    const grouped = sessions.length > GROUP_OVER
    if (grouped || sessions.length === 0) lines.push({ id: edge.id, source: edge.source, target: edge.target, label: edge.label, tone, moving: edge.state === 'working' })
    if (grouped && !expanded.has(target.id)) continue
    sessions.forEach((session, index) => {
      const id = `session:${session.id}`
      lines.push({
        id: `${grouped ? target.id : edge.source}->${id}`,
        source: grouped ? target.id : edge.source,
        target: id,
        label: sessions.length === 1 ? edge.label : `call ${String(index + 1)}${grouped ? '' : ` of ${String(sessions.length)}`}`,
        tone: toneOfState(session.state, false),
        moving: session.state === 'working',
      })
    })
  }
  return { cards, lines }
}

const RESULT_SENTENCE: Readonly<Record<BuildDiagram['result'], string>> = {
  merged: 'The build was merged into the base branch.',
  waiting_for_you: 'The build stopped and waits for your decision.',
  left_unmerged: 'The build was left unmerged; its branch is kept.',
  not_yet: 'Nothing to show yet: the build is not finished.',
}

/**
 * What the layout depends on: which cards there are, their boxes, and which lines join them --
 * never what a card says. Two reads of a build with the same key keep every card where it is.
 */
export function layoutKey(shape: DiagramShape, direction: 'RIGHT' | 'DOWN'): string {
  const cards = shape.cards.map((card) => `${card.id}:${String(card.width)}x${String(card.height)}`).sort()
  const lines = shape.lines.map((line) => `${line.source}->${line.target}`).sort()
  return `${direction}|${cards.join(',')}|${lines.join(',')}`
}
