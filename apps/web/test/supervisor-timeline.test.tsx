// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SupervisorRequest } from '../src/components/project/SupervisorRequest'
import { SupervisorTimeline } from '../src/components/project/SupervisorTimeline'
import type { NeedsYouItem } from '../src/server/needsYou'
import type { TimelineEntry } from '../src/server/timeline'

// This repo's vitest setup carries no jest-dom matchers, so every assertion reads `textContent`,
// `getAttribute` and `disabled` directly. The fetch stub is `supervisor-panel.test.tsx`'s, verbatim:
// one `vi.fn()` on the global, unstubbed in `afterEach`.

const ENTRIES: readonly TimelineEntry[] = [
  { key: 'event-9', lane: 'user_request', laneLabel: 'USER REQUEST', at: '2026-09-09T12:00:00.000Z', title: 'Add Apple Pay', detail: null, taskId: null, taskTitle: null, eventType: 'workspace.goal_set', decision: null, messageId: null, resolved: false, collapsedCount: 0 },
  { key: 'event-8', lane: 'interpretation', laneLabel: 'SUPERVISOR INTERPRETATION', at: '2026-09-09T11:59:00.000Z', title: 'understood v2: +Add Apple Pay; 3 kept', detail: null, taskId: null, taskTitle: null, eventType: 'workspace.replanned', decision: null, messageId: null, resolved: false, collapsedCount: 0 },
  { key: 'event-7', lane: 'work', laneLabel: 'WORK IN PROGRESS', at: '2026-09-09T11:58:00.000Z', title: 'Add Apple Pay', detail: 'reading src/pay.ts', taskId: 't1', taskTitle: 'Add Apple Pay', eventType: 'slave.message_sent', decision: null, messageId: null, resolved: false, collapsedCount: 2 },
  { key: 'event-6', lane: 'verified', laneLabel: 'VERIFIED RESULT', at: '2026-09-09T11:57:00.000Z', title: 'Add the banner', detail: 'feature/banner', taskId: 't2', taskTitle: 'Add the banner', eventType: 'task.verify_passed', decision: null, messageId: null, resolved: false, collapsedCount: 0 },
]

/** A decision a person ALREADY took: `supervisor.applied` is on the same lane it was asked on and
 *  renders muted rather than pinned (spec erratum E27). */
const RESOLVED_ENTRY: TimelineEntry = {
  key: 'event-5', lane: 'decision', laneLabel: 'DECISION REQUIRED', at: '2026-09-09T11:30:00.000Z',
  title: 'the review cap was raised', detail: null, taskId: null, taskTitle: null,
  eventType: 'supervisor.applied', decision: null, messageId: null, resolved: true, collapsedCount: 0,
}

const DECISION_ENTRY: TimelineEntry = {
  key: 'decision-d1', lane: 'decision', laneLabel: 'DECISION REQUIRED', at: '2026-09-09T11:00:00.000Z',
  title: 'nobody holds reviewer', detail: 'no holder', taskId: null, taskTitle: null, eventType: null,
  messageId: null, resolved: false, collapsedCount: 0,
  decision: {
    id: 'd1',
    workspaceId: 'w1',
    situationKind: 'no_reviewer',
    subjectId: 'reviewer',
    situation: { kind: 'no_reviewer', subjectId: 'reviewer', summary: 'nobody holds reviewer', facts: { role: 'reviewer', tasksWaiting: 1 } },
    candidates: [],
    chosenIndex: 0,
    action: { kind: 'escalate_to_human', summary: 'nobody holds reviewer' },
    draft: null,
    rationale: 'no holder',
    tier: 'proposed',
    status: 'pending',
    decidedBy: 'rules',
    modelCostUsd: null,
    modelCalled: false,
    failureReason: null,
    createdAt: '2026-09-09T11:00:00.000Z',
    expiresAt: null,
    resolvedAt: null,
  },
}

const QUESTION: NeedsYouItem = { kind: 'question', id: 'm1', title: 'Ada asked: Which gateway?', href: '/w/w1#question-m1', since: '2026-09-09T10:00:00.000Z', taskId: null, decisionId: null, messageId: 'm1' }
const BLOCKED: NeedsYouItem = { kind: 'blocked_task', id: 't1', title: 'Wire the webhook — no credentials', href: '/w/w1/tasks?task=t1', since: '2026-09-09T10:00:00.000Z', taskId: 't1', decisionId: null, messageId: null }
const INTEGRATE: NeedsYouItem = { kind: 'integrate', id: 't2', title: 'Add the banner — ready to integrate', href: '/w/w1/tasks?task=t2', since: '2026-09-09T10:00:00.000Z', taskId: 't2', decisionId: null, messageId: null }

let fetchMock: ReturnType<typeof vi.fn>

/** The one response every call in a case gets back. Returns the mock so a case can read the URL
 *  and the init off it. */
const stubFetch = (body: unknown, status = 200): ReturnType<typeof vi.fn> => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }))
  return fetchMock
}

/** A click whose state updates settle before the case reads the DOM. */
const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.click(element)
  })
}

const type = (element: HTMLElement, value: string): void => {
  fireEvent.change(element, { target: { value } })
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SupervisorTimeline', () => {
  it('pins DECISION REQUIRED above the river when there is one', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={[...ENTRIES, DECISION_ENTRY]} needsYou={[]} />)
    const pinned = screen.getByTestId('timeline-decisions')
    expect(within(pinned).getByTestId('supervisor-proposal')).toBeTruthy()
    expect(pinned.compareDocumentPosition(screen.getByTestId('timeline')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders no pinned section at all when nothing needs a decision', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    expect(screen.queryByTestId('timeline-decisions')).toBeNull()
  })

  /** M45 final wave, M2: a textarea with only a placeholder is unnamed to a screen reader, and a
   *  placeholder disappears the moment somebody types. */
  it('names the answer box for a screen reader', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[QUESTION]} />)
    expect(screen.getByTestId('timeline-answer-input').getAttribute('aria-label')).toBe('Answer the question')
    expect(screen.getByLabelText('Answer the question')).toBeTruthy()
  })

  it('anchors each pending decision and each question, so the needs-you links land on them', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={[DECISION_ENTRY]} needsYou={[QUESTION]} />)
    expect(document.getElementById('decision-d1')).toBeTruthy()
    expect(document.getElementById('question-m1')).toBeTruthy()
  })

  it('carries the lane and the raw event type on every entry', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    const rows = screen.getAllByTestId('timeline-entry')
    expect(rows.map((row) => row.getAttribute('data-lane'))).toEqual(['user_request', 'interpretation', 'work', 'verified'])
    expect(rows[0]?.getAttribute('data-event-type')).toBe('workspace.goal_set')
    expect(rows[0]?.getAttribute('title')).toBe('workspace.goal_set')
  })

  it('never prints a dotted event type as visible words', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    expect(screen.getByTestId('timeline').textContent).not.toContain('workspace.goal_set')
    expect(screen.getByTestId('timeline').textContent).not.toContain('slave.message_sent')
    // And nothing a model said while working reaches this river at all -- `laneFor` gives
    // `run.tool_call` no lane, so it never becomes an entry.
    expect(screen.getByTestId('timeline').textContent).not.toContain('run.')
  })

  /** M45 final wave, I3: a detail is a SECOND LINE, and an entry whose payload carries a goal
   *  document or a long rationale must not push the rest of the river off the screen. */
  it('clamps an entry detail to two lines', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    const detail = screen.getByText('reading src/pay.ts')
    expect(detail.className).toContain('line-clamp-2')
    // The whole sentence stays reachable on hover, the way the brief's objective tile does it.
    expect(detail.getAttribute('title')).toBe('reading src/pay.ts')
  })

  it('says how many earlier messages an entry stands for', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    expect(screen.getByText('+2 earlier')).toBeTruthy()
  })

  it('mutes a decision a person already took, and leaves it in the river', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={[...ENTRIES, RESOLVED_ENTRY]} needsYou={[]} />)
    // Nothing is waiting: an answered decision does not pin anything.
    expect(screen.queryByTestId('timeline-decisions')).toBeNull()
    const row = screen.getAllByTestId('timeline-entry').find((one) => one.getAttribute('data-event-type') === 'supervisor.applied')
    expect(row?.getAttribute('data-resolved')).toBe('true')
    expect(row?.className).toContain('opacity-60')
  })

  it('filters to one lane and back', async () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    await click(screen.getByTestId('timeline-lane-filter-verified'))
    expect(screen.getAllByTestId('timeline-entry')).toHaveLength(1)
    expect(screen.getByTestId('timeline-lane-filter-verified').getAttribute('aria-pressed')).toBe('true')
    await click(screen.getByTestId('timeline-lane-filter-verified'))
    expect(screen.getAllByTestId('timeline-entry')).toHaveLength(4)
  })

  it('says so when a filter empties the river', async () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    await click(screen.getByTestId('timeline-lane-filter-plan_change'))
    expect(screen.getByTestId('timeline-empty')).toBeTruthy()
    expect(screen.queryAllByTestId('timeline-entry')).toHaveLength(0)
  })

  it('approves a proposal through the decision route', async () => {
    stubFetch({ ok: true })
    render(<SupervisorTimeline workspaceId="w1" entries={[DECISION_ENTRY]} needsYou={[]} />)
    await click(screen.getByTestId('supervisor-approve'))
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/supervisor/decisions/d1/approve', expect.objectContaining({ method: 'POST' }))
  })

  it('rejects a proposal through the decision route, with the reason it was given', async () => {
    stubFetch({ ok: true })
    render(<SupervisorTimeline workspaceId="w1" entries={[DECISION_ENTRY]} needsYou={[]} />)
    type(screen.getByTestId('supervisor-reject-reason'), 'staffing is a person’s call')
    await click(screen.getByTestId('supervisor-reject'))
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/supervisor/decisions/d1/reject', expect.objectContaining({ method: 'POST' }))
    const init = fetchMock.mock.calls[0]?.[1] as { body?: string }
    expect(init.body).toContain('staffing is a person')
  })

  it('shows a refusal beside the row that was refused, and nowhere else', async () => {
    stubFetch({ error: 'that decision is no longer pending' }, 409)
    render(<SupervisorTimeline workspaceId="w1" entries={[DECISION_ENTRY]} needsYou={[BLOCKED]} />)
    await click(screen.getByTestId('supervisor-approve'))
    const errors = screen.getAllByTestId('timeline-error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.textContent).toBe('that decision is no longer pending')
    expect(errors[0]?.getAttribute('role')).toBe('alert')
  })

  it('answers an unanswerable question in place', async () => {
    stubFetch({ ok: true })
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[QUESTION]} />)
    type(screen.getByTestId('timeline-answer-input'), 'Stripe')
    await click(screen.getByTestId('timeline-answer-send'))
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/messages/m1/answer', expect.objectContaining({ method: 'POST' }))
    const init = fetchMock.mock.calls[0]?.[1] as { body?: string }
    expect(init.body).toBe(JSON.stringify({ answer: 'Stripe' }))
  })

  it('will not send an empty answer', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[QUESTION]} />)
    expect((screen.getByTestId('timeline-answer-send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('unblocks a blocked task in place', async () => {
    stubFetch({ ok: true })
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[BLOCKED]} />)
    await click(screen.getByTestId('timeline-unblock'))
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/tasks/t1/unblock', expect.objectContaining({ method: 'POST' }))
  })

  it('offers a link, not a button, for work waiting to be integrated', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[INTEGRATE]} />)
    expect(screen.getByRole('link', { name: /Add the banner/u }).getAttribute('href')).toBe('/w/w1/tasks?task=t2')
    expect(screen.queryByTestId('timeline-unblock')).toBeNull()
  })

  // Fix round 1, Important 1: nothing on this page can integrate anything (`confirmIntegration`
  // has no web route), so an integrate-only queue standing under DECISION REQUIRED would be a
  // demand nobody can satisfy here -- and a heading a person learns to ignore.
  it('gives work waiting to be integrated its own heading, not DECISION REQUIRED', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[INTEGRATE]} />)
    expect(screen.queryByTestId('timeline-decisions')).toBeNull()
    const section = screen.getByTestId('timeline-integrate-section')
    expect(section.textContent).toContain('READY TO INTEGRATE')
    expect(within(section).getAllByTestId('timeline-integrate-row')).toHaveLength(1)
    expect(screen.queryByTestId('supervisor-proposal')).toBeNull()
    expect(screen.queryByTestId('timeline-unblock')).toBeNull()
  })

  it('shows both headings when something needs answering AND something needs integrating', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={[DECISION_ENTRY]} needsYou={[BLOCKED, INTEGRATE]} />)
    const pinned = screen.getByTestId('timeline-decisions')
    expect(pinned.textContent).toContain('DECISION REQUIRED')
    expect(within(pinned).getByTestId('supervisor-proposal')).toBeTruthy()
    expect(within(pinned).getByTestId('timeline-unblock')).toBeTruthy()
    // And the integrate row is NOT under it.
    expect(within(pinned).queryByTestId('timeline-integrate-row')).toBeNull()
    expect(within(screen.getByTestId('timeline-integrate-section')).getAllByTestId('timeline-integrate-row')).toHaveLength(1)
  })

  // Fix round 1, minor 3: the queue and the timeline are two reads, and a decision recorded
  // between them reaches the brief's needs-you tile with no `DecisionView` behind it here.
  it('still shows a pending decision whose body never reached this page, as a link with no actions', () => {
    const stranded = { kind: 'decision' as const, id: 'd9', title: 'No reviewer: nobody holds reviewer', href: '/w/w1#decision-d9', since: '2026-09-09T10:00:00.000Z', taskId: null, decisionId: 'd9', messageId: null }
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[stranded]} />)
    const row = screen.getByTestId('timeline-decision-unavailable')
    expect(row.textContent).toContain('nobody holds reviewer')
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/w/w1#decision-d9')
    // The anchor its own link names is rendered, so the brief's link lands on this row.
    expect(document.getElementById('decision-d9')).toBe(row)
    // Nothing to approve: there is no decision body to send.
    expect(screen.queryByTestId('supervisor-approve')).toBeNull()
  })

  it('renders a decision once, not twice, when the queue and the entries both carry it', () => {
    const queued = { kind: 'decision' as const, id: 'd1', title: 'No reviewer: nobody holds reviewer', href: '/w/w1#decision-d1', since: '2026-09-09T11:00:00.000Z', taskId: null, decisionId: 'd1', messageId: null }
    render(<SupervisorTimeline workspaceId="w1" entries={[DECISION_ENTRY]} needsYou={[queued]} />)
    expect(screen.getAllByTestId('supervisor-proposal')).toHaveLength(1)
    expect(screen.queryByTestId('timeline-decision-unavailable')).toBeNull()
  })

  it('empties the answer box on success and keeps it on a refusal', async () => {
    stubFetch({ ok: true })
    const { unmount } = render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[QUESTION]} />)
    type(screen.getByTestId('timeline-answer-input'), 'Stripe')
    await click(screen.getByTestId('timeline-answer-send'))
    expect((screen.getByTestId('timeline-answer-input') as HTMLTextAreaElement).value).toBe('')
    unmount()

    stubFetch({ error: 'that question was already answered' }, 409)
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[QUESTION]} />)
    type(screen.getByTestId('timeline-answer-input'), 'Stripe')
    await click(screen.getByTestId('timeline-answer-send'))
    expect((screen.getByTestId('timeline-answer-input') as HTMLTextAreaElement).value).toBe('Stripe')
    expect(screen.getByTestId('timeline-error').textContent).toBe('that question was already answered')
  })

  it('will not send the same answer twice while the first is still in flight', async () => {
    let release: (() => void) | null = null
    fetchMock.mockImplementation(
      async () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        }),
    )
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[QUESTION]} />)
    type(screen.getByTestId('timeline-answer-input'), 'Stripe')
    await click(screen.getByTestId('timeline-answer-send'))
    expect((screen.getByTestId('timeline-answer-send') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      release?.()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Fix round 1, minor 7: the testid is one contract however many questions wait, so a gate that
  // has to reach ONE of them scopes by the message it belongs to.
  it('names the message each answer control belongs to', () => {
    const second = { ...QUESTION, id: 'm2', title: 'Bo asked: Which currency?', href: '/w/w1#question-m2', messageId: 'm2' }
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[QUESTION, second]} />)
    expect(screen.getAllByTestId('timeline-answer-input').map((one) => one.getAttribute('data-message-id'))).toEqual(['m1', 'm2'])
    expect(screen.getAllByTestId('timeline-answer-send').map((one) => one.getAttribute('data-message-id'))).toEqual(['m1', 'm2'])
  })

  it('marks its own root, so the page can pin where the timeline sits', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    expect(screen.getByTestId('supervisor-timeline')).toBeTruthy()
  })
})

describe('SupervisorRequest', () => {
  it('sends the words and reports the version it made', async () => {
    stubFetch({ ok: true, version: 3, sha256: 'abc', goal: '…' })
    render(<SupervisorRequest workspaceId="w1" />)
    type(screen.getByTestId('supervisor-request-input'), 'Add Apple Pay')
    await click(screen.getByTestId('supervisor-request-send'))
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/goal/request', expect.objectContaining({ method: 'POST' }))
    expect(screen.getByTestId('supervisor-request-result').textContent).toContain('goal v3')
    // A sent request leaves the box empty, ready for the next one.
    expect((screen.getByTestId('supervisor-request-input') as HTMLTextAreaElement).value).toBe('')
  })

  /** M45 final wave, M2: the same naming the timeline's answer box got. */
  it('names the request box for a screen reader', () => {
    render(<SupervisorRequest workspaceId="w1" />)
    expect(screen.getByTestId('supervisor-request-input').getAttribute('aria-label')).toBe('Tell the Supervisor')
    expect(screen.getByLabelText('Tell the Supervisor')).toBeTruthy()
  })

  it('will not send an empty request', () => {
    render(<SupervisorRequest workspaceId="w1" />)
    expect((screen.getByTestId('supervisor-request-send') as HTMLButtonElement).disabled).toBe(true)
    type(screen.getByTestId('supervisor-request-input'), '   ')
    expect((screen.getByTestId('supervisor-request-send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('will not send the same request twice while the first is still in flight', async () => {
    // `duplicate_request` is the backstop, not the UX (Task 2's handoff): the button goes down the
    // moment a POST leaves, so a double click is one write.
    let release: (() => void) | null = null
    fetchMock.mockImplementation(
      async () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify({ ok: true, version: 3, sha256: 'a', goal: 'g' }), { status: 200 }))
        }),
    )
    render(<SupervisorRequest workspaceId="w1" />)
    type(screen.getByTestId('supervisor-request-input'), 'Add Apple Pay')
    await click(screen.getByTestId('supervisor-request-send'))
    expect((screen.getByTestId('supervisor-request-send') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      release?.()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows a refusal without clearing what was typed', async () => {
    stubFetch(
      { error: 'project w1 already recorded exactly this change request at version 3: nothing was recorded', kind: 'duplicate_request' },
      409,
    )
    render(<SupervisorRequest workspaceId="w1" />)
    type(screen.getByTestId('supervisor-request-input'), 'Add Apple Pay')
    await click(screen.getByTestId('supervisor-request-send'))
    expect(screen.getByTestId('supervisor-request-result').textContent).toContain('nothing was recorded')
    expect((screen.getByTestId('supervisor-request-input') as HTMLTextAreaElement).value).toBe('Add Apple Pay')
  })
})
