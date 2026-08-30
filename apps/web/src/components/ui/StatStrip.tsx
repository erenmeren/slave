import { TONE_TEXT, type StatusTone } from './StatusPill'

export interface StatStripItem {
  readonly label: string
  readonly value: string
  readonly tone?: StatusTone
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
          <span className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">{item.label}</span>{' '}
          {/* The literal space above: label and value stack visually (flex-col), but a reader of
            * this tile's OWN `textContent` -- Task 13's project card test, `toContain` callers
            * elsewhere -- gets "label value", not "labelvalue" run together. A whitespace-only
            * text node between block children renders nothing, so this changes no pixel. */}
          <span className={`font-mono text-lg font-semibold ${item.tone !== undefined ? TONE_TEXT[item.tone] : 'text-text-1'}`}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  )
}
