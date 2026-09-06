import { z } from 'zod'

export const acceptOrderParams = z.object({ orderId: z.string() })
export const placePurchaseParams = z.object({ supplierId: z.string(), qty: z.number().int().positive() })
export const shipOrderParams = z.object({ orderId: z.string(), qty: z.number().int().positive() })
export const noteParams = z.object({ text: z.string() })

export const TRADE_ACTION_TYPES = ['accept_order', 'place_purchase', 'ship_order', 'note'] as const
export type TradeActionType = (typeof TRADE_ACTION_TYPES)[number]

export type TradeRejection =
  | { readonly kind: 'schema_invalid'; readonly detail: string }
  | { readonly kind: 'unknown_action'; readonly type: string }
  | { readonly kind: 'unknown_reference'; readonly id: string }
  | { readonly kind: 'over_constraint'; readonly constraint: string; readonly max: number }
  | { readonly kind: 'insufficient_cash'; readonly availableMinor: number; readonly costMinor: number }
  | { readonly kind: 'insufficient_stock'; readonly inventory: number }
  | { readonly kind: 'capacity_exhausted'; readonly remainingCapacity: number }
  | { readonly kind: 'over_shipment'; readonly remaining: number }
  | { readonly kind: 'order_not_open'; readonly orderId: string }
