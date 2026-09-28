/**
 * Repo-relative glob matching for package ownership (spec R3), dependency-free on purpose: the
 * domain package has no runtime dependencies beyond zod, and ownership needs three operators.
 * `**` spans any number of directories (zero included), `*` and `?` stay inside one segment,
 * everything else is literal. A trailing `/` is the directory's whole subtree.
 */
export function globToRegExp(glob: string): RegExp {
  const normalised = glob.endsWith('/') ? `${glob}**` : glob
  let source = ''
  for (let i = 0; i < normalised.length; i += 1) {
    const char = normalised[i] ?? ''
    if (char === '*' && normalised[i + 1] === '*') {
      const slashAfter = normalised[i + 2] === '/'
      source += slashAfter ? '(?:.*/)?' : '.*'
      i += slashAfter ? 2 : 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    }
  }
  return new RegExp(`^${source}$`, 'u')
}

/** A glob a package may own: repo-relative, inside the repository, forward slashes only. */
export function isValidOwnedGlob(glob: string): boolean {
  if (glob.trim() === '' || glob.startsWith('/') || glob.includes('\\')) return false
  return !glob.split('/').includes('..')
}
