import { LEAD_DECISIONS_READ_MAX } from './constants.js'

/**
 * Lead-flow spec B9 (plan A L18): the decisions in the lead's docs/DECISIONS.md -- one per `## `
 * heading, the heading its title and everything up to the next `## ` or `# ` heading its text
 * (deeper headings stay in the text). A heading with nothing under it is not a decision. Pure
 * text handling: the writer bounds and sanitises what is stored.
 */
export function parseLeadDecisions(markdown: string): readonly { readonly title: string; readonly decision: string }[] {
  const decisions: { title: string; decision: string }[] = []
  let title: string | null = null
  let body: string[] = []
  const flush = (): void => {
    if (title === null) return
    const decision = body.join('\n').trim()
    if (decision !== '') decisions.push({ title, decision })
  }
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^##\s+(.*\S)\s*$/u.exec(line)
    if (heading !== null) {
      flush()
      title = heading[1] ?? ''
      body = []
    } else if (/^#\s/u.test(line)) {
      flush()
      title = null
      body = []
    } else if (title !== null) {
      body.push(line)
    }
  }
  flush()
  return decisions.slice(0, LEAD_DECISIONS_READ_MAX)
}
