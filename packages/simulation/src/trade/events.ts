import { z } from 'zod'

const demand = z.object({ type: z.literal('demand'), qty: z.number().int().positive(), unitPriceMinor: z.number().int().nonnegative(), dueInDays: z.number().int().positive(), collectInDays: z.number().int().nonnegative() })
const supplierDelay = z.object({ type: z.literal('supplier_delay'), supplierId: z.string(), extraDays: z.number().int().positive() })
const delivery = z.object({ type: z.literal('delivery'), purchaseId: z.string() })
const paymentDue = z.object({ type: z.literal('payment_due'), purchaseId: z.string() })
const collection = z.object({ type: z.literal('collection'), orderId: z.string(), qty: z.number().int().positive() })

/** What the world can do. Only `demand` and `supplier_delay` may come from outside. */
export const tradeEventSchema = z.discriminatedUnion('type', [demand, supplierDelay, delivery, paymentDue, collection])
export const tradeExternalEventSchema = z.discriminatedUnion('type', [demand, supplierDelay])
export type TradeEvent = z.infer<typeof tradeEventSchema>
export type TradeExternalEvent = z.infer<typeof tradeExternalEventSchema>
