import { z } from 'zod'
import { areaSchema } from './state.js'

/** M31b design §3.3. `request`, `incident` and `absence` are what a person may inject; the other
 *  two are the model's own consequences and are never accepted from outside. */
const request = z.object({ type: z.literal('request'), area: areaSchema, sizeDays: z.number().int().min(1).max(5), dueInDays: z.number().int().positive() })
const incident = z.object({ type: z.literal('incident'), area: areaSchema })
const absence = z.object({ type: z.literal('absence'), engineerId: z.string(), days: z.number().int().positive() })
const taskFinished = z.object({ type: z.literal('task_finished'), taskId: z.string() })
const defectSurfaced = z.object({ type: z.literal('defect_surfaced'), taskId: z.string() })

export const softwareEventSchema = z.discriminatedUnion('type', [request, incident, absence, taskFinished, defectSurfaced])
export const softwareExternalEventSchema = z.discriminatedUnion('type', [request, incident, absence])
export type SoftwareEvent = z.infer<typeof softwareEventSchema>
export type SoftwareExternalEvent = z.infer<typeof softwareExternalEventSchema>
