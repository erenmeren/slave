import type { z } from 'zod'
import type { ActionEnvelope } from './action.js'
import type { PriorityClass } from './queue.js'

/** A role is more than a name: what it is for, what it may see, what it may do, its limits, and
 *  which roster slave holds it (frozen at creation). */
export interface RoleDefinition {
  readonly name: string
  readonly purpose: string
  readonly observes: readonly string[]
  readonly allowedActions: readonly string[]
  readonly constraints: Readonly<Record<string, number>>
  readonly slaveName: string
}

export interface ScheduleRequest<E> {
  readonly time: number
  readonly priority: PriorityClass
  readonly event: E
}

export interface Applied<S, E> {
  readonly state: S
  readonly schedule: readonly ScheduleRequest<E>[]
  readonly record?: Readonly<Record<string, unknown>>
}

/** What a sector must provide. Every function is pure; the engine owns time, the queue and the
 *  journal, the sector owns the meaning of state, actions and events. */
export interface SectorModel<S, E, R> {
  readonly name: string
  readonly eventSchema: z.ZodType<E>
  /** The subset of events a person may inject from outside (demand, a delay) — never a delivery. */
  readonly externalEventSchema: z.ZodType<E>
  observe(state: S, role: RoleDefinition): Readonly<Record<string, unknown>>
  validate(state: S, role: RoleDefinition, action: ActionEnvelope): { readonly ok: true } | { readonly ok: false; readonly reason: R }
  apply(state: S, role: RoleDefinition, action: ActionEnvelope, day: number): Applied<S, E>
  applyEvent(state: S, event: E, day: number): Applied<S, E> & { readonly record: Readonly<Record<string, unknown>> }
  closeDay(state: S, day: number): Applied<S, E> & { readonly record: Readonly<Record<string, unknown>> }
}
