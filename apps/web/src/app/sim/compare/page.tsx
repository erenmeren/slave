import { notFound } from 'next/navigation'
import { buildComparison } from '../../../server/simulation'
import { CompareClient } from '../../../components/sim/CompareClient'

export const dynamic = 'force-dynamic'

export default async function ComparePageRoute({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string }>
}): Promise<React.JSX.Element> {
  const { a, b } = await searchParams
  if (a === undefined || a === '' || b === undefined || b === '') notFound()
  const result = await buildComparison(a, b)
  if (result === null) notFound()
  if (result.kind === 'refused') return <div className="p-6 text-xs text-tone-blocked">{result.text}</div>
  return <CompareClient comparison={result.comparison} />
}
