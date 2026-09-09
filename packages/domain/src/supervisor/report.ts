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
   * answers a human has been asked to look at, and how many question situations the Supervisor
   * closed by itself in the last day.
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
  const mailboxDecisions = decisions.filter((decision) => QUESTION_KINDS.includes(decision.situationKind))

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
      // A question decision sitting `pending` at tier `proposed` is a DRAFT: `answerTier` gives an
      // unsourced answer exactly that pair, and so does a re-address a halt held back. An
      // `escalated` pending row is not a draft -- nobody is being asked to approve a text.
      draftsAwaiting: mailboxDecisions.filter(
        (decision) => decision.status === 'pending' && decision.tier === 'proposed',
      ).length,
      // Question situations the Supervisor's own machinery closed within the day: `applied` (it
      // acted by itself) and `approved` (a human said yes to what it drafted).
      //
      // `SupervisorDecisionRecord` carries the SITUATION, not the action, so an applied re-address
      // is counted here beside an answer that was sent -- both are a question that stopped waiting
      // because the Supervisor did something about it, which is what an operator reads the number
      // for. Distinguishing the two would mean carrying the action kind on every record; if that
      // ever matters, that is the change to make rather than a second guess here.
      //
      // The window is closed at its far end, so a fixed clock cannot straddle it.
      answeredBySupervisor24h: mailboxDecisions.filter(
        (decision) =>
          (decision.status === 'applied' || decision.status === 'approved') &&
          world.now - decision.createdAt <= DAY_MS,
      ).length,
    },
  }
}
