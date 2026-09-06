import { z } from 'zod'

/** What an actor may say. Free text is not an action; a claim ("500 produced") is not an effect. */
export const actionEnvelopeSchema = z.object({
  type: z.string().min(1),
  params: z.record(z.unknown()),
  rationale: z.string(),
  refs: z.array(z.string()),
})
export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>

/** The engine's own rejections; a sector adds its own union (`R` in `SectorModel`). */
export type EngineRejection =
  | { readonly kind: 'schema_invalid'; readonly detail: string }
  | { readonly kind: 'role_not_allowed'; readonly role: string; readonly type: string }
  | { readonly kind: 'limit_exceeded'; readonly limit: string }
