import type { NextConfig } from 'next'

const config: NextConfig = {
  // Workspace packages ship compiled ESM with .js specifiers; transpile keeps Next's bundler
  // from tripping on them and keeps one build graph.
  transpilePackages: ['@slave-of-ai/control', '@slave-of-ai/db', '@slave-of-ai/domain', '@slave-of-ai/events'],
  // The first redirects in this repository (M44 R1). `/slaves` and `/skills` are two of the four
  // surfaces for "a slave" the M44 audit found; they are Workforce tabs now, and their old URLs
  // still work because a bookmark is a promise. `permanent: false` (307) deliberately: a 308 is
  // cached by the browser forever, and M45/M46 rearrange this page again.
  async redirects() {
    return [
      { source: '/slaves', destination: '/workforce', permanent: false },
      { source: '/skills', destination: '/workforce?tab=skills', permanent: false },
    ]
  },
  // Gate-only (M17 Task 7, Flake 6 investigation): `scripts/gate-m14-fidelity.mjs` sets
  // `SLAVEOFAI_GATE_WARM=1` on the `next dev` it spawns. A multi-minute gate run revisits far more
  // distinct routes than the default on-demand-entries buffer holds (5 pages, evicted after 60s
  // idle) -- an evicted-then-revisited route recompiles ON DEMAND deep into the run, racing the
  // concurrent client polling/SSE traffic a live stage produces against `loadManifest`'s
  // non-atomic `readFileSync` + `JSON.parse` (no lock, no atomic rename --
  // `next/dist/server/load-manifest.external.js:41-43`), which throws `SyntaxError: Unexpected
  // end of JSON input` on a torn read (reproduced live, server- and client-side, on `/analytics`,
  // `/w/[workspaceId]/tasks` and `/w/[workspaceId]/activity` in consecutive gate runs). Left at
  // Next's defaults for an ordinary `next dev`, where eviction is the right memory tradeoff and
  // no run is long or route-diverse enough to hit this.
  ...(process.env['SLAVEOFAI_GATE_WARM'] === '1'
    ? { onDemandEntries: { maxInactiveAge: 10 * 60 * 1000, pagesBufferLength: 50 } }
    : {}),
}

export default config
