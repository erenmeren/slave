import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '@slave-of-ai/db'
import {
  LANE_BY_TYPE,
  LANE_LABEL,
  TIMELINE_LANES,
  laneFor,
  replanSentence,
  type TimelineLane,
} from '../../src/supervisor/timeline.js'

describe('LANE_BY_TYPE', () => {
  it('classifies every event type the database can store, and no more', () => {
    expect(Object.keys(LANE_BY_TYPE).sort()).toEqual(Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).sort())
  })

  it('carries the 49 members the schema has today -- a fiftieth is a deliberate decision', () => {
    expect(Object.keys(LANE_BY_TYPE)).toHaveLength(49)
  })

  it('every value is a lane this file names, or null', () => {
    for (const [type, lane] of Object.entries(LANE_BY_TYPE)) {
      expect(lane === null || (TIMELINE_LANES as readonly string[]).includes(lane), type).toBe(true)
    }
  })

  it('every lane has at least one member, so no filter is dead', () => {
    const used = new Set<TimelineLane | null>(Object.values(LANE_BY_TYPE))
    // `decision` is the one lane no EVENT reaches: it holds SupervisorDecision rows.
    for (const lane of TIMELINE_LANES) {
      if (lane === 'decision') continue
      expect(used.has(lane), lane).toBe(true)
    }
    expect(LANE_LABEL.decision).toBe('DECISION REQUIRED')
  })

  it('model chatter never reaches the timeline', () => {
    expect(LANE_BY_TYPE['run.tool_call']).toBeNull()
    expect(LANE_BY_TYPE['run.output']).toBeNull()
    expect(LANE_BY_TYPE['run.started']).toBeNull()
  })
})

describe('laneFor', () => {
  it('puts a pending decision in DECISION REQUIRED', () => {
    expect(laneFor({ source: 'decision' })).toBe('decision')
  })

  it('reads a goal set as the user request it is', () => {
    expect(laneFor({ source: 'event', type: 'workspace.goal_set', actor: 'human' })).toBe('user_request')
  })

  it('renders the re-plan pair as the interpretation', () => {
    expect(laneFor({ source: 'event', type: 'workspace.replan_started', actor: 'slave' })).toBe('interpretation')
    expect(laneFor({ source: 'event', type: 'workspace.replanned', actor: 'slave' })).toBe('interpretation')
  })

  it('splits task.created and task.cancelled on the ACTOR, not on a goal version', () => {
    expect(laneFor({ source: 'event', type: 'task.created', actor: 'slave' })).toBe('plan_change')
    expect(laneFor({ source: 'event', type: 'task.created', actor: 'human' })).toBe('user_request')
    expect(laneFor({ source: 'event', type: 'task.cancelled', actor: 'system' })).toBe('plan_change')
    expect(laneFor({ source: 'event', type: 'task.cancelled', actor: 'human' })).toBe('user_request')
  })

  it('keeps finished work apart from work in flight', () => {
    expect(laneFor({ source: 'event', type: 'task.started', actor: 'slave' })).toBe('work')
    expect(laneFor({ source: 'event', type: 'task.integrated', actor: 'system' })).toBe('verified')
    expect(laneFor({ source: 'event', type: 'task.verify_passed', actor: 'slave' })).toBe('verified')
  })

  it('answers null for anything the timeline does not show', () => {
    expect(laneFor({ source: 'event', type: 'run.tool_call', actor: 'slave' })).toBeNull()
  })
})

describe('replanSentence', () => {
  const titles = { 't1': 'Add checkout', 't2': 'Old pricing page', 't3': 'Legacy banner' }

  it('names what was added, what is proposed for cancellation and how many were kept', () => {
    expect(
      replanSentence({ version: 3, added: ['t1'], proposedCancellations: ['t2', 't3'], kept: 4 }, titles),
    ).toBe('understood v3: +Add checkout; proposes cancelling Old pricing page, Legacy banner; 4 kept')
  })

  it('says so when a re-plan changed nothing', () => {
    expect(replanSentence({ version: 2, added: [], proposedCancellations: [], kept: 5 }, titles)).toBe(
      'understood v2: nothing to add or cancel; 5 kept',
    )
  })

  it('falls back to the id when a title is gone', () => {
    expect(replanSentence({ version: 4, added: ['gone'], proposedCancellations: [], kept: 0 }, titles)).toBe(
      'understood v4: +gone; 0 kept',
    )
  })
})
