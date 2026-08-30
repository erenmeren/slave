import { TONE_BORDER, TONE_FILL, TONE_TEXT, type StatusTone } from './StatusPill'

/**
 * The handoff's avatar initials (design README "1a — Control Room": "11px mono initials"), spec
 * §3: "first letters of the first two words of the name". The mockup itself used
 * `name.slice(0, 2)`, which renders `Ch` for "Checkout" -- the spec's rule is the one implemented,
 * because a two-word name is the common case here (workspaces and companies) and `CP` reads as an
 * abbreviation while `Ch` reads as a truncation.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return '—'
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
}

/**
 * 28×28, radius 7, status colour at `1a` alpha for the fill and `3d` for the border, 11px mono
 * initials (design README "1a"). `h-7`/`w-7` are Tailwind's 28px steps -- not arbitrary values --
 * and `rounded-tile` is `globals.css`'s `--radius-tile: 7px`.
 *
 * `title` carries the full name: two letters are not an accessible label, and this tile sits
 * beside the name in some layouts and replaces it in others (the Projects team row).
 */
export function AvatarTile({ name, tone }: { readonly name: string; readonly tone: StatusTone }): React.JSX.Element {
  return (
    <span
      data-testid="avatar-tile"
      data-tone={tone}
      title={name}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-tile border font-mono text-[11px] font-semibold ${TONE_FILL[tone]} ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}
    >
      {initialsOf(name)}
    </span>
  )
}
