/**
 * The model override chain (M10 §6): a worker's own column wins over its roster row's, which wins
 * over its template's default, which falls back to the adapter's own default when every link in
 * the chain is unset. A legacy agent with no `companyAgentId` link (`companyAgent: null`) resolves
 * through its own column alone -- there is nothing else to consult.
 */
export function resolveModel(worker: {
  readonly model: string | null
  readonly companyAgent: {
    readonly model: string | null
    readonly template: { readonly defaultModel: string | null }
  } | null
}): string | undefined {
  return worker.model ?? worker.companyAgent?.model ?? worker.companyAgent?.template.defaultModel ?? undefined
}
