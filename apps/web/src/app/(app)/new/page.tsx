import { Suspense } from 'react'
import { NewProject } from '@/components/new/NewProject'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'New project · Slave of AI' }

/** New project (lead UX design section 6.2): what do I want built, and how much may it spend?
 *  `?intake=<id>` reopens a conversation already under way. */
export default function NewProjectPage(): React.JSX.Element {
  return (
    <Suspense>
      <NewProject />
    </Suspense>
  )
}
