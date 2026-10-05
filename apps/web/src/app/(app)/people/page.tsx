import { listPeople } from '@slave-of-ai/control'
import { PeopleView } from '@/components/people/PeopleView'
import { tabOf } from '@/components/people/words'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'People · Slave of AI' }

const one = (value: string | string[] | undefined): string | null => {
  const text = (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
  return text === '' ? null : text
}

/**
 * People: who can a lead call on, what kind of specialist is each, and what can they be handed?
 * The first page of the list is read here so the first paint carries it; the address says which
 * tab, person or persona is open (`?tab=`, `?person=`, `?persona=`) and which filter a link asked
 * for (`?skill=`, `?from=` a persona).
 */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<React.JSX.Element> {
  const params = await searchParams
  const [skillId, templateId] = [one(params['skill']), one(params['from'])]
  const location = { tab: tabOf(one(params['tab']) ?? undefined), personId: one(params['person']), personaId: one(params['persona']), skillId, templateId }
  const initial = await listPeople({ ...(skillId === null ? {} : { skillId }), ...(templateId === null ? {} : { templateId }) })
  return <PeopleView initial={initial} location={location} />
}
