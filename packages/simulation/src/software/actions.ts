import { z } from 'zod'
import type { ActionDoc } from '../core/action-docs.js'

export const acceptRequestParams = z.object({ taskId: z.string() })
export const assignTaskParams = z.object({ taskId: z.string(), engineerId: z.string() })
export const reviewTaskParams = z.object({ taskId: z.string() })
export const noteParams = z.object({ text: z.string() })

export const SOFTWARE_ACTION_TYPES = ['accept_request', 'assign_task', 'review_task', 'note'] as const
export type SoftwareActionType = (typeof SOFTWARE_ACTION_TYPES)[number]

/** M31b design §3.2's rejection union, verbatim, with the id or figure that made each verdict. */
export type SoftwareRejection =
  | { readonly kind: 'bad_params'; readonly detail: string }
  | { readonly kind: 'unknown_action'; readonly type: string }
  | { readonly kind: 'unknown_task'; readonly taskId: string }
  | { readonly kind: 'wrong_status'; readonly status: string }
  | { readonly kind: 'unknown_engineer'; readonly engineerId: string }
  | { readonly kind: 'engineer_busy'; readonly engineerId: string }
  | { readonly kind: 'engineer_absent'; readonly engineerId: string }
  | { readonly kind: 'review_capacity_exhausted'; readonly reviewCapacityPerDay: number }

/** The `when` sentences are §3.2's role purposes said from the action's side: what a role is
 *  reaching for the action to do, in the vocabulary the params already use. */
export const SOFTWARE_ACTION_DOCS: readonly ActionDoc[] = [
  { type: 'accept_request', params: '{ taskId }', when: 'accept a requested feature into the queue' },
  { type: 'assign_task', params: '{ taskId, engineerId }', when: 'give a queued task to an engineer who is free and not absent today' },
  { type: 'review_task', params: '{ taskId }', when: 'review a finished task, within the day\'s remaining review capacity' },
  { type: 'note', params: '{ text }', when: 'record an observation or rationale with no effect on state' },
]
