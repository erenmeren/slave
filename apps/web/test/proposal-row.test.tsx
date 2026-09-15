// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProposalRow, actionText } from '../src/components/supervisor/ProposalRow.js'
import type { SupervisorView } from '../src/server/supervisor.js'

/**
 * The row a proposal is read and answered in, tested where it now lives (M57 t5 / spec erratum
 * E18).
 *
 * `ProposalRow`, `DraftEditor` and `actionText` moved out of `SupervisorPanel.tsx` when that panel
 * was deleted, and their cases came with them -- rewritten to render the ROW rather than a panel
 * around it, which is the boundary they were always about. What they do NOT cover is which URL an
 * answer is posted to: the row takes two callbacks, and the two components that mount it
 * (`project/SupervisorTimeline.tsx`, `organization/OrganizationClient.tsx`) each pin their own
 * envelopes in their own tests.
 */

type Decision = SupervisorView['pending'][number]
type Question = SupervisorView['questions'][number]

const decision = (over: Partial<Decision>): Decision => ({
  id: 'd1',
  workspaceId: 'w1',
  situationKind: 'no_reviewer',
  subjectId: 'reviewer',
  situation: {
    kind: 'no_reviewer',
    subjectId: 'reviewer',
    summary: 'A task is in review and no worker holds the reviewer role.',
    facts: { role: 'reviewer', tasksWaiting: 1 },
  },
  candidates: [],
  chosenIndex: 0,
  action: { kind: 'set_runtime_roles', slaveId: 'a1', roles: ['backend', 'reviewer'] },
  // M39 t2: every decision row carries a draft column now -- null for every action but
  // `answer_question`, which is what a staffing proposal is.
  draft: null,
  rationale: 'Alex is idle and their title already reads as reviewer.',
  tier: 'proposed',
  status: 'pending',
  decidedBy: 'model',
  modelCostUsd: 0.02,
  modelCalled: true,
  failureReason: null,
  createdAt: '2026-09-09T10:00:00.000Z',
  expiresAt: '2026-09-10T10:00:00.000Z',
  resolvedAt: null,
  ...over,
})

/** An `answer_question` proposal with the drafted answer a human is asked to read, edit and
 *  approve (M39 §6) -- the shape `recordDecision` writes for an interpretation the citations of
 *  which did not all verify. */
const answerDecision = (over?: Partial<Decision>): Decision =>
  decision({
    id: 'd-answer',
    situationKind: 'waiting_stale',
    subjectId: 'm-1',
    situation: {
      kind: 'waiting_stale',
      subjectId: 'm-1',
      summary: 'A slave has been waiting on an answer for two hours.',
      facts: { messageId: 'm-1' },
    },
    action: { kind: 'answer_question', messageId: 'm-1' },
    draft: {
      body: 'Land them on the payments-retry queue.',
      sources: [{ kind: 'task', ref: null, quote: 'retries go to payments-retry' }],
      rejectedSources: [{ source: { kind: 'goal', ref: null, quote: 'ship by friday' }, reason: 'quote_not_found' }],
      critical: { lexicon: ['spend'], model: true },
      confidence: 'interpretation',
    },
    rationale: 'the task description looks like it answers this.',
    ...over,
  })

const question = (over?: Partial<Question>): Question => ({
  messageId: 'm-1',
  body: 'Which queue should retries land on?',
  askerName: 'Alex (backend)',
  waitingOn: 'anyone with the product role',
  holders: 0,
  since: '2026-09-09T08:00:00.000Z',
  ...over,
})

const onApprove = vi.fn()
const onReject = vi.fn()

beforeEach((): void => {
  onApprove.mockReset()
  onReject.mockReset()
})

/** The row IS an `<li>`, so it is mounted inside the list its two call sites give it. */
function renderRow(
  row: Decision,
  over: { readonly questions?: readonly Question[]; readonly taskTitles?: Readonly<Record<string, string>> } = {},
): void {
  render(
    <ul>
      <ProposalRow
        decision={row}
        questions={over.questions ?? [question()]}
        taskTitles={over.taskTitles ?? {}}
        busy={false}
        onApprove={onApprove}
        onReject={onReject}
      />
    </ul>,
  )
}

describe('actionText', () => {
  it('names the task a cancel_task proposal is about, with the reason it was proposed for', () => {
    expect(
      actionText({ kind: 'cancel_task', taskId: 't-1', reason: 'the re-plan for goal v2 no longer needs it' }, { 't-1': 'Wire up the refunds form' }),
    ).toBe('cancel task Wire up the refunds form: the re-plan for goal v2 no longer needs it')
  })

  // M47 R4: the three arms of the exhaustive switch. Each names the capability the offer is FOR,
  // because the situation chip beside it only says that one is missing.
  it('names the role an assign_capability grants and the capability it is for', () => {
    expect(
      actionText({
        kind: 'assign_capability',
        slaveId: 'Rae',
        capability: 'security.application',
        capabilityLabel: 'Application security',
        role: 'security',
      }),
      // Final review, Minor 5b: the WORDS, off the action itself -- a panel in a browser has no
      // taxonomy to resolve a key with, and the key is one field away on the same row.
    ).toBe('give Rae the "security" runtime role, for Application security')
  })

  it('names the person a materialise_company_worker seats', () => {
    expect(
      actionText({
        kind: 'materialise_company_worker',
        personId: 'p1',
        capability: 'security.application',
        capabilityLabel: 'Application security',
        name: 'Sam',
        rationale: 'Sam is already on the company roster and provides Application security.',
      }),
    ).toBe('seat Sam on this project from the pool, for Application security')
  })

  it('says when a catalog hire is a temporary specialist, and says nothing when it is not', () => {
    const hire = {
      kind: 'hire_from_catalog',
      templateId: 'tpl1',
      capability: 'security.application',
      capabilityLabel: 'Application security',
      name: 'Security Reviewer',
      rationale: 'nobody here provides Application security',
      // M50 R2: the engagement is what makes the hire temporary, and `actionText` reads neither --
      // the flag is the whole of what it says. Carried here because the action type requires it.
      engagementTaskId: null,
    } as const
    expect(actionText({ ...hire, temporary: false })).toBe(
      'hire Security Reviewer from the catalog, for Application security',
    )
    expect(actionText({ ...hire, temporary: true })).toBe(
      'hire Security Reviewer from the catalog as a temporary specialist, for Application security',
    )
  })

  // M51 R3, fix round 1 (Minor 9). The SENTENCE is on the action and this function reads it back
  // verbatim -- it runs in the browser and has no breaker constants to re-derive it from -- so a
  // decision read months later says what was actually sent, in the quotes that mark it as a quote.
  it('quotes the steer sentence the action carries, rather than re-deriving one', () => {
    const text =
      'You have made the same tool call 8 times with no new result. Stop, say in one paragraph what you are stuck on, and either change approach or report why you cannot.'
    expect(actionText({ kind: 'steer_run', runId: 'run-1', slaveId: 's1', text })).toBe(
      `tell that run to stop and rethink: “${text}”`,
    )
  })

  // M52 R5: the worker's NAME and the operation's LABEL, both carried on the action. This function
  // runs in the browser and may not import the domain's label table through control's barrel, which
  // is the same reason `capabilityLabel` rides on `assign_capability`.
  it('asks for a permission by the worker’s name and the operation’s word, never the key', () => {
    expect(
      actionText({
        kind: 'request_permission',
        slaveId: 'a1',
        name: 'Alex',
        permissionKind: 'network_fetch',
        kindLabel: 'Fetch over the network',
        why: 'three calls were refused in the last half hour',
      }),
    ).toBe('ask a person to let Alex fetch over the network')
  })

  it('falls back to the id for a task the world no longer holds', () => {
    // Findable, rather than a name this function would have to invent.
    expect(actionText({ kind: 'cancel_task', taskId: 't-9', reason: 'no longer needed' }, {})).toBe(
      'cancel task t-9: no longer needed',
    )
  })
})

describe('ProposalRow', () => {
  it('shows the proposal with its situation, its action and the reason it was chosen', () => {
    renderRow(decision({}))

    expect(screen.getByTestId('supervisor-proposal-summary').textContent).toContain('no worker holds the reviewer role')
    expect(screen.getByTestId('supervisor-proposal-action').textContent).toContain('backend, reviewer')
    expect(screen.getByTestId('supervisor-proposal-rationale').textContent).toBe(
      'Alex is idle and their title already reads as reviewer.',
    )
  })

  it('names the task in a cancel_task proposal, so a human is not asked to approve a uuid (M40 §6)', () => {
    renderRow(
      decision({
        id: 'd-cancel',
        situationKind: 'stale_task',
        subjectId: 't-1',
        situation: {
          kind: 'stale_task',
          subjectId: 't-1',
          summary: 'the re-plan for goal v2 no longer needs "Wire up the refunds form"',
          facts: { goalVersion: 1, currentVersion: 2, reason: 'replan_cancel' },
        },
        action: { kind: 'cancel_task', taskId: 't-1', reason: 'the re-plan for goal v2 no longer needs it' },
        rationale: 'the re-plan for goal v2 no longer needs this task',
      }),
      { taskTitles: { 't-1': 'Wire up the refunds form' } },
    )

    // M44 R5 leak 5: the kind chip printed the enum member. The word is what a person reads; the
    // raw kind stays in `title`.
    expect(screen.getByTestId('supervisor-proposal-kind').textContent).toBe('Work the goal no longer needs')
    expect(screen.getByTestId('supervisor-proposal-kind').getAttribute('title')).toBe('stale_task')
    expect(screen.getByTestId('supervisor-proposal-action').textContent).toBe(
      'cancel task Wire up the refunds form: the re-plan for goal v2 no longer needs it',
    )
  })

  it('reads a capability proposal in words: the label chip, the sentence and the raw kind (M47 R4)', () => {
    renderRow(
      decision({
        id: 'd-capability',
        situationKind: 'capability_unstaffed',
        subjectId: 'security.application',
        situation: {
          kind: 'capability_unstaffed',
          subjectId: 'security.application',
          summary: '1 startable task(s) need Application security and no slave can be dispatched as security.',
          facts: { capability: 'security.application', role: 'security', readyTasks: 1, firstTaskId: 't-1' },
        },
        action: {
          kind: 'hire_from_catalog',
          templateId: 'tpl1',
          capability: 'security.application',
          capabilityLabel: 'Application security',
          name: 'Security Reviewer',
          rationale: 'Security Reviewer provides Application security, which nobody on this project does.',
          temporary: false,
          engagementTaskId: null,
        },
        rationale: 'Security Reviewer provides Application security, which nobody on this project does.',
      }),
    )

    // M44 R5 leak 5 / `docs/ia.md` rule 3: the word is what a person reads, the member stays in
    // `title` so the raw value is still available.
    expect(screen.getByTestId('supervisor-proposal-kind').textContent).toBe('Missing a capability')
    expect(screen.getByTestId('supervisor-proposal-kind').getAttribute('title')).toBe('capability_unstaffed')
    expect(screen.getByTestId('supervisor-proposal-action').textContent).toBe(
      'hire Security Reviewer from the catalog, for Application security',
    )
  })

  it('rejects with the typed reason, and with none at all when the box is empty', () => {
    renderRow(decision({}))

    fireEvent.click(screen.getByTestId('supervisor-reject'))
    expect(onReject).toHaveBeenCalledWith('')

    fireEvent.change(screen.getByTestId('supervisor-reject-reason'), { target: { value: 'staffing is a person’s call' } })
    fireEvent.click(screen.getByTestId('supervisor-reject'))
    expect(onReject).toHaveBeenLastCalledWith('staffing is a person’s call')
  })

  it('renders another party rationale as text, never as markup', () => {
    renderRow(decision({ rationale: '<img src=x onerror="boom()">' }))

    const rationale = screen.getByTestId('supervisor-proposal-rationale')
    expect(rationale.textContent).toBe('<img src=x onerror="boom()">')
    expect(rationale.querySelector('img')).toBeNull()
  })
})

// ---- M39 t4: the drafted answer, its evidence, and the edit box ---------------------------------

describe('a drafted answer', () => {
  it('shows the question it would answer, the draft in an editable box, and how confident it is', () => {
    renderRow(answerDecision())

    expect(screen.getByTestId('supervisor-draft-question').textContent).toBe('Which queue should retries land on?')
    expect((screen.getByTestId('supervisor-draft-body') as HTMLTextAreaElement).value).toBe(
      'Land them on the payments-retry queue.',
    )
    expect(screen.getByTestId('supervisor-draft-confidence').textContent).toContain('interpretation')
  })

  it('quotes every verified source with where it came from, and marks a rejected one with its reason', () => {
    renderRow(answerDecision())

    const verified = screen.getAllByTestId('supervisor-draft-source')
    expect(verified).toHaveLength(1)
    expect(verified[0]?.textContent).toContain('retries go to payments-retry')
    expect(verified[0]?.textContent).toContain('task')
    const rejected = screen.getAllByTestId('supervisor-draft-rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.textContent).toContain('ship by friday')
    expect(rejected[0]?.textContent).toContain('quote_not_found')
  })

  it('names both critical signals -- the lexicon match and the model flag', () => {
    renderRow(answerDecision())

    const critical = screen.getByTestId('supervisor-draft-critical').textContent ?? ''
    expect(critical).toContain('spend')
    expect(critical).toMatch(/model/i)
  })

  it('says nothing about critical when neither signal fired', () => {
    renderRow(answerDecision({ draft: { ...answerDecision().draft!, critical: { lexicon: [], model: false } } }))

    expect(screen.queryByTestId('supervisor-draft-critical')).toBeNull()
  })

  it("seeds the box from a human's earlier edit when the row carries one, and shows it as the edit", () => {
    renderRow(
      answerDecision({ draft: { ...answerDecision().draft!, editedBody: 'Use the retry topic, not the queue.' } }),
    )

    expect((screen.getByTestId('supervisor-draft-body') as HTMLTextAreaElement).value).toBe(
      'Use the retry topic, not the queue.',
    )
    expect(screen.getByTestId('supervisor-draft-edited').textContent).toContain('Use the retry topic, not the queue.')
  })

  it('offers an empty box on an escalated draft that has no body at all, so a human can answer it', () => {
    renderRow(answerDecision({ draft: { ...answerDecision().draft!, body: null } }))

    expect((screen.getByTestId('supervisor-draft-body') as HTMLTextAreaElement).value).toBe('')
  })

  it('approving an edited draft hands the typed body up', () => {
    renderRow(answerDecision())

    fireEvent.change(screen.getByTestId('supervisor-draft-body'), { target: { value: 'Use the retry topic.' } })
    fireEvent.click(screen.getByTestId('supervisor-approve'))

    expect(onApprove).toHaveBeenCalledWith('Use the retry topic.')
  })

  it("approving an untouched draft hands up nothing -- the Supervisor's own words go out", () => {
    renderRow(answerDecision())

    fireEvent.click(screen.getByTestId('supervisor-approve'))

    // FIRST that the approve fired at all (final review Minor 8): an `undefined` argument is what
    // a button that did nothing would also produce, so the call itself is asserted before its
    // argument.
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onApprove).toHaveBeenCalledWith(undefined)
  })

  it('renders a draft, a quote and a question as text, never as markup', () => {
    renderRow(
      answerDecision({
        draft: {
          ...answerDecision().draft!,
          body: '<img src=x onerror="boom()">',
          sources: [{ kind: 'task', ref: null, quote: '<script>boom()</script>' }],
        },
      }),
    )

    const box = screen.getByTestId('supervisor-draft-body') as HTMLTextAreaElement
    expect(box.value).toBe('<img src=x onerror="boom()">')
    expect(box.querySelector('img')).toBeNull()
    const source = screen.getByTestId('supervisor-draft-source')
    expect(source.textContent).toContain('<script>boom()</script>')
    expect(source.querySelector('script')).toBeNull()
  })

  it('shows no draft block on a proposal that is not an answer', () => {
    renderRow(decision({}))

    expect(screen.queryByTestId('supervisor-draft-body')).toBeNull()
  })

  it('shows the summary alone when the question it would answer has already been settled', () => {
    renderRow(answerDecision(), { questions: [] })

    expect(screen.queryByTestId('supervisor-draft-question')).toBeNull()
    expect(screen.getByTestId('supervisor-draft-body')).toBeTruthy()
  })

  // M58 R16: the middle tier is the pool, and the word an operator reads says so. The raw
  // TeamSource stays on `data-source`.
  it('names a pool_person proposal FROM THE POOL, with the raw source beside it', () => {
    renderRow(
      decision({
        id: 'd-pool',
        situationKind: 'capability_unstaffed',
        subjectId: 'security.application',
        situation: {
          kind: 'capability_unstaffed',
          subjectId: 'security.application',
          summary: '1 startable task(s) need Application security and no slave can be dispatched as security.',
          facts: { capability: 'security.application', role: 'security', readyTasks: 1, firstTaskId: 't-1' },
        },
        action: {
          kind: 'materialise_company_worker',
          personId: 'p1',
          capability: 'security.application',
          capabilityLabel: 'Application security',
          name: 'Sam',
          rationale: 'Sam is already on the company roster and provides Application security.',
        },
        rationale: 'Sam already works here and holds no seat on this project.',
      }),
    )

    const row = screen.getByTestId('supervisor-proposal')
    expect(row.getAttribute('data-source')).toBe('pool_person')
    expect(screen.getByTestId('supervisor-proposal-source').textContent).toBe('FROM THE POOL')
  })
})
