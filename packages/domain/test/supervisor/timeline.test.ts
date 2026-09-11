import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '@slave-of-ai/db'
import {
  LANE_BY_TYPE,
  LANE_LABEL,
  TIMELINE_LANES,
  isResolvedDecision,
  laneFor,
  replanSentence,
  type TimelineLane,
} from '../../src/supervisor/timeline.js'

describe('LANE_BY_TYPE', () => {
  it('classifies every event type the database can store, and no more', () => {
    expect(Object.keys(LANE_BY_TYPE).sort()).toEqual(Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).sort())
  })

  it('carries the 50 members the schema has today -- a fifty-first is a deliberate decision', () => {
    expect(Object.keys(LANE_BY_TYPE)).toHaveLength(50)
  })

  it('every value is a lane this file names, or null', () => {
    for (const [type, lane] of Object.entries(LANE_BY_TYPE)) {
      expect(lane === null || (TIMELINE_LANES as readonly string[]).includes(lane), type).toBe(true)
    }
  })

  it('every lane has at least one member, so no filter is dead', () => {
    const used = new Set<TimelineLane | null>(Object.values(LANE_BY_TYPE))
    // Every lane, `decision` included: spec erratum E27 puts the two events that RESOLVE a
    // decision on the lane the decision was asked on, so a person's answer leaves its trace there.
    for (const lane of TIMELINE_LANES) {
      expect(used.has(lane), lane).toBe(true)
    }
    expect(LANE_LABEL.decision).toBe('DECISION REQUIRED')
  })

  it('a decision that was taken stays on the lane it was asked on', () => {
    expect(LANE_BY_TYPE['supervisor.applied']).toBe('decision')
    expect(LANE_BY_TYPE['supervisor.resolved']).toBe('decision')
    // The PROPOSAL is not an entry: the pending `SupervisorDecision` row is, via `laneFor`.
    expect(LANE_BY_TYPE['supervisor.proposed']).toBeNull()
    expect(LANE_BY_TYPE['supervisor.decided']).toBeNull()
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

  it('puts an unanswered question and a blocked task in DECISION REQUIRED too', () => {
    expect(laneFor({ source: 'question' })).toBe('decision')
    expect(laneFor({ source: 'blocked_task' })).toBe('decision')
  })

  it('answers null for anything the timeline does not show', () => {
    expect(laneFor({ source: 'event', type: 'run.tool_call', actor: 'slave' })).toBeNull()
  })
})

describe('isResolvedDecision', () => {
  it('is true for exactly the two events that record a decision already taken', () => {
    expect(isResolvedDecision({ source: 'event', type: 'supervisor.applied', actor: 'system' })).toBe(true)
    expect(isResolvedDecision({ source: 'event', type: 'supervisor.resolved', actor: 'human' })).toBe(true)
  })

  it('is false for everything still waiting on a person', () => {
    expect(isResolvedDecision({ source: 'decision' })).toBe(false)
    expect(isResolvedDecision({ source: 'question' })).toBe(false)
    expect(isResolvedDecision({ source: 'blocked_task' })).toBe(false)
    expect(isResolvedDecision({ source: 'event', type: 'task.started', actor: 'slave' })).toBe(false)
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
