/** One line of the model's action documentation: what an action is called, what it takes, when
 *  a role would use it. Kept as data so the prompt and any future UI read the same source.
 *
 *  M31b controller ruling R2: the interface lives in `core/` because `core/plugin.ts` names it in
 *  the `SectorPlugin` contract and every sector -- trade, software, whatever comes third -- fills
 *  it in. `trade/action-docs.ts` re-exports the type so no consumer's import changes. */
export interface ActionDoc {
  readonly type: string
  readonly params: string
  readonly when: string
}
