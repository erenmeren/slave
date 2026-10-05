import { listProjects } from '@slave-of-ai/control'
import { HomeView } from '@/components/home/HomeView'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Projects · Slave of AI' }

/** Home (lead UX design section 6.1): is anything waiting for me, and how are my projects doing? */
export default async function HomePage(): Promise<React.JSX.Element> {
  return <HomeView initial={await listProjects()} />
}
