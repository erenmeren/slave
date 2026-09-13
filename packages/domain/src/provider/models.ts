/**
 * One entry of a provider's model list: the id the CLI accepts after `--model`, and a label
 * (M56a erratum E2 -- MOVED here from `packages/providers/src/models.ts`, which re-exports it).
 *
 * It moved for one reason: a `configured` provider's manifest HOLDS its model table
 * (`ProviderModelDiscovery`), the manifest lives in this package, and this package cannot import
 * `@slave-of-ai/providers`. `ModelListing` -- the shape of an ANSWER, with its `source` and its
 * `error` -- stays there, because nothing about it is a fact about a vendor.
 */
export interface ModelOption {
  readonly id: string
  readonly label: string
  readonly default?: true
}
