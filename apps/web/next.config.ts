import type { NextConfig } from 'next'

const config: NextConfig = {
  // Workspace packages ship compiled ESM with .js specifiers; transpile keeps Next's bundler
  // from tripping on them and keeps one build graph.
  transpilePackages: ['@ai-team-os/control', '@ai-team-os/db', '@ai-team-os/domain', '@ai-team-os/events'],
}

export default config
