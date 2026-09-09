import { observe } from './observe.js'
import type { Situation, SituationKind } from './situations.js'
import type { SupervisorWorld } from './world.js'

/** The two situation kinds that are about the mailbox -- a question waiting, or one nobody can
 *  take. Every mailbox count below is over decisions on these. */
const QUESTION_KINDS: readonly SituationKind[] = ['waiting_stale', 'unanswerable_question']

/** The window `answeredBySupervisor24h` counts over, closed at both ends. */
const DAY_MS = 24 * 3_600_000

/**
 * The answer to "what is done, what is stuck, what comes next" (M38 goal), plus what the
 * Supervisor itself has been doing. Pure data: the web panel, the CLI and the tick report all
 * render this rather than each counting rows their own way.
 */
export interface SupervisorReport {
  done: { integrated: number; awaitingIntegration: number }
  stuck: readonly Situation[]
  next: { ready: number; running: number; waiting: number; blocked: number }
  supervisor: {
    applied: number
    pending: number
    escalated: number
    failed: number
    /** Epoch ms of the newest decision in the world's window, or null if there is none. */
    lastDecisionAt: number | null
  }
  /**
   * The Supervisor's mailbox (M39 section 3): how many questions are waiting, how many drafted
   * answers a human has been asked to look at, and how many questions the Supervisor ANSWERED by
   * itself in the last day. The last two are about `answer_question` decisions specifically, not
   * about every decision on a question -- see the fields' own comments in {@link summarise}.
   */
  mailbox: {
    pendingQuestions: number
    draftsAwaiting: number
    answeredBySupervisor24h: number
  }
}

/**
 * Summarises a world for a human (spec E2: computed by whoever holds the world -- the web view
 * builder, the CLI -- not by a control verb of its own).
 *
 * `stuck` is the RAW {@link observe} output, deliberately not `filterFresh`ed: the cooldown and the
 * one-open-decision rule exist to stop the DECIDER repeating itself, and an operator asking what is
 * stuck must still see the thing a proposal is waiting on.
 *
 * The `supervisor` counts are over `world.decisions`, which is a recent window rather than the
 * whole history -- the report says what the Supervisor has been doing lately, not since the
 * workspace was created. `pending` (a status: waiting on a human) and `escalated` (a tier: this
 * decision was an escalation) deliberately overlap; an escalation sits in `pending` until someone
 * answers it.
 */
export function summarise(world: SupervisorWorld): SupervisorReport {
  const countStatus = (status: SupervisorWorld['tasks'][number]['status']): number =>
    world.tasks.filter((task) => task.status === status).length

  const done = world.tasks.filter((task) => task.status === 'done')
  const decisions = world.decisions
  // Both halves have to agree before a row counts as mailbox work: the situation is about a
  // question AND the action was an answer. A stored `answer_question` on any other situation kind
  // is a shape the catalogue never builds, and counting it would be trusting one field over two.
  const answerDecisions = decisions.filter(
    (decision) => QUESTION_KINDS.includes(decision.situationKind) && decision.actionKind === 'answer_question',
  )

  return {
    done: {
      integrated: done.filter((task) => task.integratedAt !== null).length,
      awaitingIntegration: done.filter((task) => task.integratedAt === null).length,
    },
    stuck: observe(world),
    next: {
      ready: countStatus('ready'),
      running: countStatus('running'),
      waiting: countStatus('waiting'),
      blocked: countStatus('blocked'),
    },
    supervisor: {
      applied: decisions.filter((decision) => decision.status === 'applied').length,
      pending: decisions.filter((decision) => decision.status === 'pending').length,
      escalated: decisions.filter((decision) => decision.tier === 'escalated').length,
      failed: decisions.filter((decision) => decision.status === 'failed').length,
      lastDecisionAt:
        decisions.length === 0 ? null : decisions.reduce((newest, d) => Math.max(newest, d.createdAt), -Infinity),
    },
    mailbox: {
      // The world's `questions` are the PENDING ones by contract, so this is the mailbox itself
      // rather than a count of decisions about it.
      pendingQuestions: world.questions.length,
      // Every `answer_question` decision still waiting on a human, whatever tier it was recorded
      // at. An unsourced answer is `proposed` and a critical one `escalated`, and BOTH put a draft
      // in front of a person to approve, edit or refuse -- erratum E2's lexicon draft has no body
      // at all, and a human answers the question by typing into it (Task 2 fix round 1). A pending
      // re-address on the same question is not counted: nobody is being asked to approve a text.
      draftsAwaiting: answerDecisions.filter((decision) => decision.status === 'pending').length,
      // Questions the Supervisor's own ANSWER closed within the day: `applied` (it sent the answer
      // itself) and `approved` (a human said yes to its draft). `actionKind` is what makes this
      // the number an operator reads it as -- an applied RE-ADDRESS also stops a question waiting,
      // but nobody answered it, and counting the two together (which is all a record carrying only
      // the situation could do, before the Task 1 review added the action kind) overstated what the
      // Supervisor had actually said.
      //
      // The window is closed at its far end, so a fixed clock cannot straddle it.
      answeredBySupervisor24h: answerDecisions.filter(
        (decision) =>
          (decision.status === 'applied' || decision.status === 'approved') &&
          world.now - decision.createdAt <= DAY_MS,
      ).length,
    },
  }
}
