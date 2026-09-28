const SYMBOL_PATTERNS: readonly (readonly [RegExp, RegExp])[] = [
  [/\.(?:[cm]?[jt]sx?)$/u, /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu],
  [/\.py$/u, /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gmu],
  [/\.go$/u, /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/gmu],
  [/\.rs$/u, /^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_]\w*)/gmu],
]
const SYMBOLS_PER_FILE = 12

/**
 * The names a file exposes at its top level, by a regex per language (spec §6: "top-level
 * symbols -- bounded"). A heuristic, not a parser: the conductor needs to know WHERE things live
 * to draw ownership lines, not a symbol table.
 */
export function topLevelSymbols(path: string, text: string): readonly string[] {
  const pattern = SYMBOL_PATTERNS.find(([file]) => file.test(path))?.[1]
  if (pattern === undefined) return []
  const names: string[] = []
  for (const match of text.matchAll(pattern)) {
    const name = match[1]
    if (name !== undefined && !names.includes(name)) names.push(name)
    if (names.length >= SYMBOLS_PER_FILE) break
  }
  return names
}

export interface RepoFileEntry {
  readonly path: string
  readonly bytes: number
  readonly symbols: readonly string[]
}

/** One line per file, cut at `maxChars` with a count of what was left out. */
export function renderRepositoryMap(entries: readonly RepoFileEntry[], totalFiles: number, maxChars: number): string {
  const lines: string[] = []
  let used = 0
  const reserve = 60
  for (const entry of entries) {
    const line = `${entry.path} (${entry.bytes} B)${entry.symbols.length === 0 ? '' : `: ${entry.symbols.join(', ')}`}`
    if (used + line.length + 1 > maxChars - reserve) break
    lines.push(line)
    used += line.length + 1
  }
  const left = totalFiles - lines.length
  if (left > 0) lines.push(`… ${left} more files not listed`)
  return lines.join('\n')
}

export interface CatalogueLine {
  readonly templateId: string
  readonly name: string
  readonly division: string | null
  readonly capabilities: readonly string[]
}

/** The personas the conductor may pick from, one line each, cut at `maxChars`. */
export function renderCatalogue(lines: readonly CatalogueLine[], maxChars: number): string {
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const text = `${line.templateId} | ${line.name} | ${line.division ?? '-'} | ${line.capabilities.join(', ')}`
    if (used + text.length + 1 > maxChars) break
    out.push(text)
    used += text.length + 1
  }
  return out.join('\n')
}
