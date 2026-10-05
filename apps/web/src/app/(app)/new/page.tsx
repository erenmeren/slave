import { NewProject } from '@/components/new/NewProject'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'New project · Slave of AI' }

/** New project (lead UX design section 6.2): what do I want built, and how much may it spend? */
export default function NewProjectPage(): React.JSX.Element {
  return <NewProject />
}
