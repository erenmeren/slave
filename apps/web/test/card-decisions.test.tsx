// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  CARD_PATH_MAX_CHARS,
  HANDOFF_CHANGE_MAX_CHARS,
  PERSON_CARD_TEXT_MAX_CHARS,
  SHARED_DECISION_TEXT_MAX_CHARS,
  SHARED_DECISION_TITLE_MAX_CHARS,
} from '@slave-of-ai/domain'
import { CardDecisions } from '../src/components/supervisor/CardDecisions'
import type { SupervisorView } from '../src/server/supervisor'

/**
 * Human cards plan B, Task 7: the decisions a question card offers, in the browser. The component
 * posts nothing itself -- it hands the route's exact body to `onDecide`, and the two pages that mount
 * it (`SupervisorTimeline`, `OrganizationClient`) post it through their own `send`, whose notices and
 * errors their own tests pin. Every assertion reads the DOM directly: this repo's vitest setup
 * carries no jest-dom matchers.
 */

type Card = NonNullable<SupervisorView['pending'][number]['card']>
type Draft = NonNullable<SupervisorView['pending'][number]['draft']>

const card: Card = {
  messageId: 'm1',
  body: 'May I edit backend/package.json?',
  goalVersion: 1,
  askerPackageKey: 'integration',
  askerRunId: 'r1',
  askerWaiting: true,
  closed: null,
  timeoutRefusal: null,
  lateAnswerNote: null,
  lateAnswerFate: null,
  packages: [
    { key: 'skeleton', title: 'The runnable skeleton', isIntegration: false },
    { key: 'integration', title: 'Integrate', isIntegration: true },
  ],
  offers: ['write_answer', 'give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'],
}

const plainDraft: Draft = {
  body: 'Yes.',
  sources: [],
  rejectedSources: [],
  critical: { lexicon: [], model: false },
  confidence: 'interpretation',
}

/** A conductor draft that really carries a shared decision and a hand-off (plan 5's I2 block). */
const conductorDraft: Draft = {
  ...plainDraft,
  conductor: {
    basis: { requirements: [], packages: [], decisions: [] },
    unverified: [],
    changes: 'none',
    newDecision: { title: 'Scripts', decision: 'every script lives in backend/package.json' },
    handOff: { package: 'skeleton', change: 'add a start script' },
  },
}

const timedOut = { reason: 'timed_out', at: '2026-10-02T10:00:00.000Z', by: 'system', byName: 'Slave', runContinued: true } as const

function renderCard(over: { readonly card?: Partial<Card>; readonly draft?: Draft | null; readonly busy?: boolean } = {}): ReturnType<typeof vi.fn> {
  const onDecide = vi.fn()
  render(<CardDecisions card={{ ...card, ...over.card }} draft={over.draft ?? null} busy={over.busy ?? false} onDecide={onDecide} />)
  return onDecide
}

const choose = (kind: string): void => {
  fireEvent.click(screen.getByTestId(`card-decision-${kind}`))
}
const type = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}
const decideButton = (): HTMLButtonElement => screen.getByTestId('card-decide') as HTMLButtonElement
const note = (): string => screen.getByTestId('card-decision-note').textContent ?? ''

describe('CardDecisions (human cards H2)', () => {
  it('offers only what the card offers, and sends a give-work decision as one body', () => {
    const onDecide = renderCard()
    expect(screen.queryByTestId('card-decision-send_answer')).toBeNull()
    choose('give_work')
    type('card-target-package', 'skeleton')
    type('card-text', 'add a "start" script')
    fireEvent.click(decideButton())
    expect(onDecide).toHaveBeenCalledWith({ kind: 'give_work', target: { package: 'skeleton' }, request: 'add a "start" script' })
  })

  it('renders exactly the offered decisions, in the order the server gave them, and nothing at all when none is offered', () => {
    renderCard({ card: { offers: ['send_answer', 'dismiss'] }, draft: plainDraft })
    expect(screen.getAllByTestId(/^card-decision-[a-z_]+$/u).map((button) => button.getAttribute('data-testid'))).toEqual([
      'card-decision-send_answer',
      'card-decision-dismiss',
    ])
  })

  it('renders nothing to choose on a card that offers nothing', () => {
    renderCard({ card: { offers: [] } })
    expect(screen.queryAllByTestId(/^card-decision-/u)).toHaveLength(0)
    expect(screen.queryByTestId('card-decide')).toBeNull()
  })

  it.each([
    {
      kind: 'send_answer',
      fill: (): void => undefined,
      body: { kind: 'send_answer' },
    },
    {
      kind: 'write_answer',
      fill: (): void => type('card-text', 'Yes, but name it "serve".'),
      body: { kind: 'write_answer', body: 'Yes, but name it "serve".' },
    },
    {
      kind: 'give_work',
      fill: (): void => {
        type('card-path', 'backend/package.json')
        type('card-text', 'Add a start script.')
      },
      body: { kind: 'give_work', target: { path: 'backend/package.json' }, request: 'Add a start script.' },
    },
    {
      kind: 'record_decision',
      fill: (): void => {
        type('card-title', 'Scripts')
        type('card-text', 'Every package script lives in backend/package.json.')
      },
      body: { kind: 'record_decision', title: 'Scripts', text: 'Every package script lives in backend/package.json.' },
    },
  ])('sends $kind as the exact body the decide route takes', ({ kind, fill, body }) => {
    const onDecide = renderCard({ card: { offers: [...card.offers, 'send_answer'] }, draft: plainDraft })
    choose(kind)
    fill()
    fireEvent.click(decideButton())
    expect(onDecide).toHaveBeenCalledTimes(1)
    expect(onDecide).toHaveBeenCalledWith(body)
  })

  it.each([
    {
      kind: 'give_file',
      fill: (): void => {
        type('card-path', 'src/api/routes.ts')
        type('card-target-package', 'skeleton')
      },
      confirm: 'give src/api/routes.ts to the skeleton package',
      body: { kind: 'give_file', path: 'src/api/routes.ts', toPackage: 'skeleton' },
    },
    {
      kind: 'change_requirement',
      fill: (): void => type('card-text', 'Ship a start script too.'),
      confirm: 'open a new goal version with this change',
      body: { kind: 'change_requirement', request: 'Ship a start script too.' },
    },
    {
      kind: 'dismiss',
      fill: (): void => type('card-text', 'not needed'),
      confirm: 'close the question without an answer',
      body: { kind: 'dismiss', reason: 'not needed' },
    },
    {
      kind: 'dismiss',
      fill: (): void => type('card-text', '   '),
      confirm: 'close the question without an answer',
      body: { kind: 'dismiss', reason: null },
    },
  ])('asks twice before $kind, saying in plain words what it will do, then sends the exact body', ({ kind, fill, confirm, body }) => {
    const onDecide = renderCard()
    choose(kind)
    fill()
    fireEvent.click(decideButton())
    // The first click only asks: nothing is sent until the sentence was in front of the person.
    expect(onDecide).not.toHaveBeenCalled()
    const confirmButton = screen.getByTestId('card-decide-confirm')
    expect(confirmButton.textContent).toBe(confirm)
    fireEvent.click(confirmButton)
    expect(onDecide).toHaveBeenCalledTimes(1)
    expect(onDecide).toHaveBeenCalledWith(body)
  })

  it('keeps decide down until the form is a decision the route would take', () => {
    renderCard()
    choose('give_work')
    expect(decideButton().disabled).toBe(true)
    type('card-text', 'Add a start script.')
    // A package or a file, never neither and never both.
    expect(decideButton().disabled).toBe(true)
    type('card-target-package', 'skeleton')
    expect(decideButton().disabled).toBe(false)
    type('card-path', 'backend/package.json')
    expect(decideButton().disabled).toBe(true)
    choose('record_decision')
    type('card-title', 'Scripts')
    expect(decideButton().disabled).toBe(true)
    type('card-text', '  ')
    expect(decideButton().disabled).toBe(true)
  })

  it('says what applies: the draft\'s decision and hand-off on send, nothing of them on a written answer', () => {
    renderCard({ card: { offers: ['send_answer', 'write_answer', 'dismiss'] }, draft: conductorDraft })
    choose('send_answer')
    expect(note()).toContain('its shared decision and hand-off apply')
    choose('write_answer')
    expect(note()).toContain("the draft's decision and hand-off do not apply")
  })

  it('claims nothing about a decision or a hand-off a plain draft does not carry (F61)', () => {
    renderCard({ card: { offers: ['send_answer', 'write_answer', 'dismiss'] }, draft: plainDraft })
    choose('send_answer')
    expect(note()).not.toContain('hand-off')
    choose('write_answer')
    expect(note()).not.toContain('hand-off')
  })

  it('names only what a conductor draft carries, and that a draft edited earlier applies neither', () => {
    const decisionOnly: Draft = { ...conductorDraft, conductor: { ...conductorDraft.conductor!, handOff: null } }
    renderCard({ card: { offers: ['send_answer', 'dismiss'] }, draft: decisionOnly })
    choose('send_answer')
    expect(note()).toContain('its shared decision applies')
    expect(note()).not.toContain('hand-off')
  })

  it('says a conductor draft a person edited earlier sends the edit, without its decision and hand-off', () => {
    renderCard({ card: { offers: ['send_answer', 'dismiss'] }, draft: { ...conductorDraft, editedBody: 'Yes, as "serve".' } })
    choose('send_answer')
    expect(note()).toContain('edited')
    expect(note()).toContain('do not apply')
  })

  it('seeds a written answer with the draft, and keeps each decision\'s words apart', () => {
    renderCard({ card: { offers: ['send_answer', 'write_answer', 'give_work', 'dismiss'] }, draft: { ...plainDraft, editedBody: 'Yes, as "serve".' } })
    choose('write_answer')
    expect((screen.getByTestId('card-text') as HTMLTextAreaElement).value).toBe('Yes, as "serve".')
    choose('give_work')
    expect((screen.getByTestId('card-text') as HTMLTextAreaElement).value).toBe('')
    type('card-text', 'Add it.')
    choose('write_answer')
    expect((screen.getByTestId('card-text') as HTMLTextAreaElement).value).toBe('Yes, as "serve".')
  })

  it('says where a decision goes once the run continued without an answer', () => {
    renderCard({ card: { askerWaiting: false, closed: timedOut, lateAnswerFate: 'hand_off' } })
    choose('write_answer')
    expect(note()).toContain('reaches the integration package as a hand-off')
  })

  it("says an answer now reaches the task's next run when the asker has no package", () => {
    renderCard({ card: { askerPackageKey: null, askerWaiting: false, closed: timedOut, lateAnswerFate: 'next_run' } })
    choose('write_answer')
    expect(note()).toContain("reaches the task's next run")
  })

  it('offers no answer on a timed-out card no run would read, and says why (F37)', () => {
    renderCard({
      card: {
        askerWaiting: false,
        closed: timedOut,
        lateAnswerFate: 'unread',
        offers: ['give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'],
      },
    })
    expect(screen.queryByTestId('card-decision-send_answer')).toBeNull()
    expect(screen.queryByTestId('card-decision-write_answer')).toBeNull()
    expect(screen.getByTestId('card-decisions-no-answer').textContent).toContain('no run would read an answer')
  })

  it('tells a dismiss whether a run waits on the question', () => {
    renderCard()
    choose('dismiss')
    expect(note()).toContain('the waiting run continues on its safest assumption')
  })

  it('tells a dismiss that no run waits, when none does', () => {
    renderCard({ card: { askerWaiting: false } })
    choose('dismiss')
    expect(note()).toContain('no run is waiting on it')
    expect(note()).not.toContain('safest assumption')
  })

  it('says what a file, a requirement and a shared decision do before they are chosen', () => {
    renderCard()
    choose('give_file')
    expect(note()).toContain('the only way a file changes owner')
    expect(note()).toContain('refused while either package is running')
    choose('change_requirement')
    expect(note()).toContain('new goal version')
    expect(note()).toContain('superseded')
    choose('record_decision')
    expect(note()).toContain('goal v1')
  })

  it('names every form control, and shows the limits the route enforces', () => {
    renderCard({ card: { offers: [...card.offers, 'send_answer'] }, draft: plainDraft })
    choose('give_file')
    expect(screen.getByLabelText(/^the package/u)).toBe(screen.getByTestId('card-target-package'))
    expect(screen.getByLabelText(/^the file/u)).toBe(screen.getByTestId('card-path'))
    expect((screen.getByTestId('card-path') as HTMLInputElement).maxLength).toBe(CARD_PATH_MAX_CHARS)
    choose('record_decision')
    const title = screen.getByTestId('card-title') as HTMLInputElement
    const text = screen.getByTestId('card-text') as HTMLTextAreaElement
    expect(screen.getByLabelText(`title (at most ${String(SHARED_DECISION_TITLE_MAX_CHARS)} characters)`)).toBe(title)
    expect(title.maxLength).toBe(SHARED_DECISION_TITLE_MAX_CHARS)
    expect(screen.getByLabelText(`the decision (at most ${String(SHARED_DECISION_TEXT_MAX_CHARS)} characters)`)).toBe(text)
    expect(text.maxLength).toBe(SHARED_DECISION_TEXT_MAX_CHARS)
    choose('write_answer')
    expect((screen.getByTestId('card-text') as HTMLTextAreaElement).maxLength).toBe(PERSON_CARD_TEXT_MAX_CHARS)
    expect(screen.getByLabelText(`your answer (at most ${String(PERSON_CARD_TEXT_MAX_CHARS)} characters)`)).toBeTruthy()
    choose('give_work')
    expect((screen.getByTestId('card-text') as HTMLTextAreaElement).maxLength).toBe(HANDOFF_CHANGE_MAX_CHARS)
    choose('change_requirement')
    expect((screen.getByTestId('card-text') as HTMLTextAreaElement).maxLength).toBe(PERSON_CARD_TEXT_MAX_CHARS)
    choose('dismiss')
    expect((screen.getByTestId('card-text') as HTMLTextAreaElement).maxLength).toBe(PERSON_CARD_TEXT_MAX_CHARS)
    expect(screen.getByLabelText(/^why \(optional/u)).toBe(screen.getByTestId('card-text'))
    // The choices are one named group, and the chosen one says it is chosen.
    expect(screen.getByRole('group', { name: 'decide this question' })).toBeTruthy()
    expect(screen.getByTestId('card-decision-dismiss').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('card-decision-give_work').getAttribute('aria-pressed')).toBe('false')
  })

  it('takes every button down while a decision is in flight', () => {
    renderCard({ busy: true })
    for (const button of screen.getAllByTestId(/^card-decision-[a-z_]+$/u)) expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('takes decide down while a decision is in flight, so it cannot be sent twice', () => {
    const onDecide = vi.fn()
    const { rerender } = render(<CardDecisions card={card} draft={null} busy={false} onDecide={onDecide} />)
    choose('dismiss')
    rerender(<CardDecisions card={card} draft={null} busy onDecide={onDecide} />)
    expect(decideButton().disabled).toBe(true)
    choose('give_work')
    expect(screen.getByTestId('card-decision-give_work').getAttribute('aria-pressed')).toBe('false')
  })

  it('renders a package title and a drafted answer as text, never as markup', () => {
    renderCard({
      card: { offers: ['write_answer', 'give_work'], packages: [{ key: 'web', title: '<img src=x onerror="boom()">', isIntegration: false }] },
      draft: { ...plainDraft, body: '<script>boom()</script>' },
    })
    choose('give_work')
    const picker = screen.getByTestId('card-target-package')
    expect(picker.textContent).toContain('<img src=x onerror="boom()">')
    expect(picker.querySelector('img')).toBeNull()
    choose('write_answer')
    const box = screen.getByTestId('card-text') as HTMLTextAreaElement
    expect(box.value).toBe('<script>boom()</script>')
    expect(box.querySelector('script')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })
})
