import { happeningNow, listProjects } from '@slave-of-ai/control'
import { HomeView } from '@/components/home/HomeView'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Projects · Slave of AI' }

/** Home (lead UX design section 6.1): is anything waiting for me, how are my projects doing, and
 *  what is happening on them right now? */
export default async function HomePage(): Promise<React.JSX.Element> {
  const [projects, happening] = await Promise.all([listProjects(), happeningNow()])
  return <HomeView initial={projects} happening={happening} />
}
