export function HaltBanner({ reason }: { readonly reason: string }): React.JSX.Element {
  return (
    <div role="alert" className="border-b border-status-danger/40 bg-status-danger/10 px-4 py-2 text-sm text-status-danger">
      workspace halted: {reason} — retract with <code className="font-mono">clear-halt</code> (CLI)
    </div>
  )
}
