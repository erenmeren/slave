import { buildSkillsPage } from '../../server/skills'
import { SkillsClient } from '../../components/SkillsClient'

export const dynamic = 'force-dynamic'

/** `/skills` is GLOBAL — the catalog is a fact about the daemon host's disk, not about a
 *  workspace (M14 §5, routes note). */
export default async function SkillsPage(): Promise<React.JSX.Element> {
  return <SkillsClient page={await buildSkillsPage()} />
}
