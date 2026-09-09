import { observe } from './observe.js'
import type { Situation } from './situations.js'
import type { SupervisorWorld } from './world.js'

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
  }
}
