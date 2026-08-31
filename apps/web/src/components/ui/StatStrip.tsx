import { SECTION_LABEL_CLASS } from './SectionLabel'
import { TONE_TEXT, type StatusTone } from './StatusPill'

export interface StatStripItem {
  readonly label: string
  readonly value: string
  readonly tone?: StatusTone
  /**
   * An optional line UNDER the value, inside the tile (M14 fix wave, queue item (f)). The one
   * idiom for "this figure knows less than it looks like it knows": `TopStrip` already nests its
   * `strip-unmeasured` inside the spend tile, and Projects used to hang the same sentence off the
   * bottom of the whole strip. Same defect, two placements. It goes in the tile it qualifies --
   * a caveat that is not beside its number is a caveat a reader has to work to attach.
   */
  readonly note?: React.ReactNode
}

/** The handoff stat strip (spec §3): an n-up row of `label`/`value` tiles with 1px gutters. */
export function StatStrip({ items }: { readonly items: ReadonlyArray<StatStripItem> }): React.JSX.Element {
  return (
    <div
      data-testid="stat-strip"
      className="grid gap-px overflow-hidden rounded-tile border border-line bg-line"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} data-testid="stat-strip-item" className="flex flex-col gap-1 bg-bg-1 p-[10px]">
          <span className={SECTION_LABEL_CLASS}>{item.label}</span>{' '}
          {/* The literal space above: label and value stack visually (flex-col), but a reader of
            * this tile's OWN `textContent` -- Task 13's project card test, `toContain` callers
            * elsewhere -- gets "label value", not "labelvalue" run together. A whitespace-only
            * text node between block children renders nothing, so this changes no pixel. */}
          <span className={`font-mono text-lg font-semibold ${item.tone !== undefined ? TONE_TEXT[item.tone] : 'text-text-1'}`}>
            {item.value}
          </span>{' '}
          {/* The same literal space as above, for the same reason: this tile's own `textContent`
            * must read "spend $4.00 2 runs unmeasured", not "$4.002 runs". Whitespace-only text
            * nodes are not rendered as flex items, so no pixel moves. */}
          {item.note}
        </div>
      ))}
    </div>
  )
}
