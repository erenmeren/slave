import { redirect } from 'next/navigation'
import Link from 'next/link'
import { listWorkspaces } from '../server/workspaces'

export const dynamic = 'force-dynamic'

export default async function Home(): Promise<React.JSX.Element> {
  const workspaces = await listWorkspaces()
  if (workspaces.length === 1 && workspaces[0] !== undefined) redirect(`/w/${workspaces[0].id}`)
  if (workspaces.length === 0) {
    return <main className="p-6 text-text-2">There are no workspaces. Seed one first.</main>
  }
  return (
    <main className="p-6">
      <h1 className="mb-4 text-sm text-text-2">Pick a workspace</h1>
      <ul className="flex flex-col gap-2">
        {workspaces.map((w) => (
          <li key={w.id}>
            <Link className="text-text-1 underline" href={`/w/${w.id}`}>
              {w.name} <span className="font-mono text-xs text-text-3">{w.id}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
