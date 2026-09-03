import { describe, expect, it } from 'vitest'
import { foldCommunication, type FoldEvent } from '../src/lib/communicationFold.js'

describe('foldCommunication', () => {
  it('planner -> implementer: a plan\'s first run.started on each planned task', () => {
    const events: FoldEvent[] = [
      { type: 'workspace.plan_created', agentId: 'mgr', taskId: null, actor: 'agent', payload: { tasks: [{ id: 't1' }] }, seq: 1 },
      { type: 'run.started', agentId: 'alex', taskId: 't1', actor: 'agent', payload: { sessionId: 's1' }, seq: 2 },
    ]
    expect(foldCommunication(events)).toEqual({ edges: [{ from: 'mgr', to: 'alex', kind: 'plan', count: 1 }] })
  })

  it('implementer -> reviewer: review_started names the reviewer of the latest run.started', () => {
    const events: FoldEvent[] = [
      { type: 'run.started', agentId: 'alex', taskId: 't1', actor: 'agent', payload: { sessionId: 's1' }, seq: 1 },
      { type: 'task.review_started', agentId: 'maya', taskId: 't1', actor: 'agent', payload: { title: 'x' }, seq: 2 },
    ]
    expect(foldCommunication(events)).toEqual({ edges: [{ from: 'alex', to: 'maya', kind: 'review', count: 1 }] })
  })

  it('reviewer -> implementer: review_rejected followed by the next run.started on the same task', () => {
    const events: FoldEvent[] = [
      { type: 'task.review_rejected', agentId: 'maya', taskId: 't1', actor: 'agent', payload: { reason: 'no', attempt: 1 }, seq: 1 },
      { type: 'run.started', agentId: 'alex', taskId: 't1', actor: 'agent', payload: { sessionId: 's2' }, seq: 2 },
    ]
    expect(foldCommunication(events)).toEqual({ edges: [{ from: 'maya', to: 'alex', kind: 'rework', count: 1 }] })
  })

  it('operator -> agent: a human message_sent naming the agent', () => {
    const events: FoldEvent[] = [
      {
        type: 'agent.message_sent',
        agentId: 'alex',
        taskId: 't1',
        actor: 'human',
        payload: { category: 'instruction', body: 'go' },
        seq: 1,
      },
    ]
    expect(foldCommunication(events)).toEqual({ edges: [{ from: 'operator', to: 'alex', kind: 'message', count: 1 }] })
  })

  it('counts accumulate across repeats of the same edge', () => {
    const events: FoldEvent[] = [
      { type: 'agent.message_sent', agentId: 'alex', taskId: 't1', actor: 'human', payload: { category: 'instruction', body: 'a' }, seq: 1 },
      { type: 'agent.message_sent', agentId: 'alex', taskId: 't1', actor: 'human', payload: { category: 'instruction', body: 'b' }, seq: 2 },
      { type: 'agent.message_sent', agentId: 'alex', taskId: 't2', actor: 'human', payload: { category: 'instruction', body: 'c' }, seq: 3 },
    ]
    expect(foldCommunication(events)).toEqual({ edges: [{ from: 'operator', to: 'alex', kind: 'message', count: 3 }] })
  })

  it('edges sort by (from, to, kind)', () => {
    const events: FoldEvent[] = [
      { type: 'agent.message_sent', agentId: 'zoe', taskId: 't1', actor: 'human', payload: { category: 'instruction', body: 'a' }, seq: 1 },
      { type: 'agent.message_sent', agentId: 'alex', taskId: 't2', actor: 'human', payload: { category: 'instruction', body: 'b' }, seq: 2 },
      { type: 'run.started', agentId: 'alex', taskId: 't3', actor: 'agent', payload: { sessionId: 's1' }, seq: 3 },
      { type: 'task.review_started', agentId: 'maya', taskId: 't3', actor: 'agent', payload: { title: 'x' }, seq: 4 },
    ]
    const { edges } = foldCommunication(events)
    expect(edges.map((e) => `${e.from}|${e.to}|${e.kind}`)).toEqual([
      'alex|maya|review',
      'operator|alex|message',
      'operator|zoe|message',
    ])
  })

  it('self-edges are dropped', () => {
    const events: FoldEvent[] = [
      { type: 'workspace.plan_created', agentId: 'alex', taskId: null, actor: 'agent', payload: { tasks: [{ id: 't1' }] }, seq: 1 },
      { type: 'run.started', agentId: 'alex', taskId: 't1', actor: 'agent', payload: { sessionId: 's1' }, seq: 2 },
    ]
    expect(foldCommunication(events)).toEqual({ edges: [] })
  })

  it('unknown implementer (no run.started) yields no edge', () => {
    const events: FoldEvent[] = [
      { type: 'task.review_started', agentId: 'maya', taskId: 't1', actor: 'agent', payload: { title: 'x' }, seq: 1 },
    ]
    expect(foldCommunication(events)).toEqual({ edges: [] })
  })
})
