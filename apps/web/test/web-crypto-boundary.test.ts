import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

/**
 * Whitespace and comments, together: what may legally sit between `import` and the specifier it
 * names. Spelled out because a block comment between the paren and the quote -- a webpack magic
 * comment is the everyday reason to write one -- is valid TypeScript, and a bare whitespace class
 * does not span it (fix round 1, item 3).
 */
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`
const SPECIFIER = String.raw`['"](?:node:)?crypto['"]`

/**
 * The module specifier, in every shape a bundler honours and in both the prefixed and the bare form:
 * `from 'crypto'` (static and re-export), `require('node:crypto')`, `import('crypto')`, and the bare
 * side-effect `import 'crypto'` -- each with comments or newlines anywhere between the keyword and
 * the quote.
 *
 * Applied to the RAW source, because no comment in this tree writes a specifier -- a comment that
 * documents the ban writes the module's NAME, which is what the second, comment-stripped pass below
 * is for. The paren forms are listed BEFORE the bare `import` form so the alternation reaches them
 * first.
 */
const CRYPTO_IMPORT_RE = new RegExp(
  String.raw`(?:\bfrom${GAP}|\brequire${GAP}\(${GAP}|\bimport${GAP}\(${GAP}|\bimport${GAP})${SPECIFIER}`,
  'u',
)

/**
 * Source with comments removed, crudely and deliberately so.
 *
 * The ban is on what the code DOES, and a comment that explains the ban has to be able to name the
 * thing it bans: `apps/web/src/lib/session.ts:22` says why neither runtime offers `timingSafeEqual`,
 * and the webhook route's own header says there is no `node:crypto` in it. A scan that reads prose
 * would make both sentences unwriteable, which is the wrong trade -- documentation of a rule is not
 * a breach of it.
 *
 * This stripper does not parse TypeScript: a `//` inside a string literal (a url) eats the rest of
 * that line. Every such mistake removes text, so the only error it can make is a FALSE NEGATIVE on
 * the tail of a line that already held a url -- and `CRYPTO_IMPORT_RE` above runs against the raw
 * source precisely so the import, the one shape that actually matters, is checked without it.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/.*$/gmu, ' ')
}

/**
 * `node:crypto` is banned in `apps/web/src` (M54 global constraints; the rule is stated at
 * `apps/web/src/lib/session.ts:1-7` and was enforced by nothing).
 *
 * The reason is the EDGE runtime: `middleware.ts` and everything it imports compile for it, and
 * Web Crypto is what that runtime has. The rule is wider than the middleware's own import graph on
 * purpose -- a helper written for a route today is imported by the middleware tomorrow, and the
 * failure mode is a build that breaks on deploy rather than a test that goes red.
 *
 * M54 is the milestone that made this load-bearing: the webhook route needs an HMAC, and the HMAC
 * lives in `packages/control` (`verifyHookDelivery`), which is server-only by construction.
 */
describe('apps/web/src never reaches for Node crypto (M54 R3)', () => {
  it('imports it nowhere, and calls createHmac nowhere', () => {
    const files = walk(new URL('../src', import.meta.url).pathname).filter(
      (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
    )
    expect(files.length).toBeGreaterThan(100)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} imports the crypto module`).not.toMatch(CRYPTO_IMPORT_RE)
      const code = codeOf(source)
      expect(code, `${file} names node:crypto in code`).not.toContain('node:crypto')
      expect(code, `${file} calls createHmac`).not.toMatch(/createHmac|timingSafeEqual/)
    }
  })
})
