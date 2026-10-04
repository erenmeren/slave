import { LEAD_DECISIONS_FILE } from './constants.js'

/**
 * Lead-flow spec B3: the rules of the flow, the last thing a lead reads at the start of a session
 * (the `lead` manifest kind's trailer). No way to ask is offered (spec R-6).
 *
 * A leaf module beside `./constants.js` and nothing else: `run-context/render.ts` imports it, and
 * anything heavier here (the brief's sanitising, `conduct/verification.js`) would close an import
 * cycle back into the renderer.
 *
 * Must never contain the fake CLI's routing literals or a protocol marker: every lead prompt carries
 * it, and the fake routes a prompt by them.
 */
export const LEAD_RULES = [
  'How to work: you are the lead of this goal. Build all of it on this branch -- yourself, and through subordinate sessions you start, brief and check.',
  'Stay on this branch. Commit as you go: only what is committed is judged. Never push, never switch branches, never rewrite history.',
  'The README must say exactly how to install, start and use the product, and scripts/smoke.sh must start it and exercise it.',
  `Nobody answers questions while you build. Where the goal leaves something open, decide it yourself and record each decision with its reason in ${LEAD_DECISIONS_FILE}, one "## <title>" heading per decision.`,
  'How the result is judged: an independent verifier installs and starts the product from the README and checks every requirement on the running product. Passing tests are not enough. What it finds comes back to you in this same session.',
  'Finish with a closing report as your final message: what is built, what is not built, and what a person must do before release.',
].join('\n')
