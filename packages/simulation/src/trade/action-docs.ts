/** One line of the model's action documentation: what an action is called, what it takes, when
 *  a role would use it. Kept as data so the prompt and any future UI read the same source. */
export interface ActionDoc {
  readonly type: string
  readonly params: string
  readonly when: string
}

/** Documents the trade sector's four action types (`src/trade/actions.ts`) in the shape the
 *  purchasing rules already act on (`src/trade/rules.ts`): the param names here are the real
 *  fields `place_purchase` and its siblings validate against, not a paraphrase. */
export const TRADE_ACTION_DOCS: readonly ActionDoc[] = [
  { type: 'accept_order', params: '{ orderId }', when: 'accept a pending demand into an order' },
  { type: 'place_purchase', params: '{ supplierId, qty }', when: 'buy stock from a supplier to cover a shortfall against open orders' },
  { type: 'ship_order', params: '{ orderId, qty }', when: 'ship stock against an open order, within today\'s remaining capacity' },
  { type: 'note', params: '{ text }', when: 'record an observation or rationale with no effect on state' },
]
