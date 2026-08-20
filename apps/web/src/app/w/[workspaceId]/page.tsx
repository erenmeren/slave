import { buildOverviewSnapshot } from '../../../server/overview'

export const dynamic = 'force-dynamic'

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const snapshot = await buildOverviewSnapshot(workspaceId)
  if (snapshot === null) return <main className="p-6 text-status-danger">no workspace with id {workspaceId}</main>
  return (
    <main className="p-6">
      <pre className="font-mono text-xs text-text-2">{JSON.stringify(snapshot, null, 2)}</pre>
    </main>
  )
}
