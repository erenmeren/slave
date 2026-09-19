import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * `/organization` → `/w/:id` (M61 R7/Task 6): Team IS the project's own page now
 * (`lib/routes.ts`'s `sectionOf` has answered `team` for this route since Task 2), and this old
 * route is kept only as a redirect target -- every link anybody has ever saved still lands
 * somewhere real. Query params carry over so a `?slave=` deep link still opens the same panel.
 */
export default async function OrganizationRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<never> {
  const { workspaceId } = await params
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(await searchParams)) {
    const first = typeof v === 'string' ? v : v?.[0]
    if (first !== undefined) query.set(k, first)
  }
  const qs = query.toString()
  redirect(`/w/${workspaceId}${qs === '' ? '' : `?${qs}`}`)
}
