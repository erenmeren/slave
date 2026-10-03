/**
 * Who a `workspace.package_handed_off` event's hand-off came from, in the words a person reads --
 * the ONE rule the timeline's sentence and the activity card both use (plan B Task 8 carry), so the
 * two never name one hand-off two ways.
 *
 * A hand-off from a package is named by its package, off the event alone. A package-less one is
 * named by the server (`packageLessHandOffNames`: the operator, a worker's seat for its late answer,
 * the conductor) when the page was given that name; failing that -- an event that arrived on the
 * live stream, or a hand-off row that is gone -- by the event's own source: a person's as the
 * operator's, any other as the conductor's.
 */
export function handOffSender(payload: Record<string, unknown>, named: string | null | undefined): string {
  const from = payload['fromPackage']
  if (typeof from === 'string') return from
  if (typeof named === 'string' && named !== '') return named
  return payload['source'] === 'person' ? 'the operator' : 'the conductor'
}
