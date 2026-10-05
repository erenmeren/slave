import { listHelpers } from '@slave-of-ai/control'
import { HelpersView } from '@/components/helpers/HelpersView'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Helpers · Slave of AI' }

/** Helpers (lead UX design section 6.5): who can the lead call on? */
export default async function HelpersPage(): Promise<React.JSX.Element> {
  return <HelpersView helpers={await listHelpers()} />
}
