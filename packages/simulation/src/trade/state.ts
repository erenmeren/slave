import { z } from 'zod'

export const supplierSchema = z.object({ id: z.string(), name: z.string(), unitPriceMinor: z.number().int().nonnegative(), leadDays: z.number().int().nonnegative(), paymentTermDays: z.number().int().nonnegative() })
export const pendingDemandSchema = z.object({ id: z.string(), qty: z.number().int().positive(), unitPriceMinor: z.number().int().nonnegative(), dueDay: z.number().int(), collectInDays: z.number().int().nonnegative() })
export const orderSchema = z.object({
  id: z.string(), qty: z.number().int().positive(), remaining: z.number().int().nonnegative(), unitPriceMinor: z.number().int().nonnegative(),
  dueDay: z.number().int(), collectInDays: z.number().int().nonnegative(), shippedQty: z.number().int().nonnegative(), lastShipDay: z.number().int().nullable(),
  status: z.enum(['open', 'partially_shipped', 'shipped']),
})
export const purchaseSchema = z.object({
  id: z.string(), supplierId: z.string(), qty: z.number().int().positive(), unitPriceMinor: z.number().int().nonnegative(), orderedDay: z.number().int(),
  expectedDay: z.number().int(), deliveredDay: z.number().int().nullable(), payDay: z.number().int(), status: z.enum(['ordered', 'delivered']), paid: z.boolean(),
})
export const tradeStateSchema = z.object({
  cashMinor: z.number().int(), inventory: z.number().int().nonnegative(), dailyShipCapacity: z.number().int().nonnegative(), shippedToday: z.number().int().nonnegative(),
  minCashMinor: z.number().int(), minCashDay: z.number().int(), nextId: z.number().int().positive(),
  pendingDemand: z.array(pendingDemandSchema), orders: z.array(orderSchema), purchases: z.array(purchaseSchema), suppliers: z.array(supplierSchema),
})
export type Supplier = z.infer<typeof supplierSchema>
export type PendingDemand = z.infer<typeof pendingDemandSchema>
export type Order = z.infer<typeof orderSchema>
export type Purchase = z.infer<typeof purchaseSchema>
export type TradeState = z.infer<typeof tradeStateSchema>

export function unpaidCommitmentsMinor(state: TradeState): number {
  return state.purchases.filter((p) => !p.paid).reduce((sum, p) => sum + p.qty * p.unitPriceMinor, 0)
}

export function initialTradeState(input: { readonly cashMinor: number; readonly inventory: number; readonly dailyShipCapacity: number; readonly suppliers: readonly Supplier[] }): TradeState {
  return { cashMinor: input.cashMinor, inventory: input.inventory, dailyShipCapacity: input.dailyShipCapacity, shippedToday: 0, minCashMinor: input.cashMinor, minCashDay: 0, nextId: 1, pendingDemand: [], orders: [], purchases: [], suppliers: [...input.suppliers] }
}
