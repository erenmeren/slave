import type { ProviderKind } from '@slave-of-ai/domain'

/**
 * Each runtime's own "ask the user a question" tool (H9 F6), by the name its `permission_denied`
 * event carries.
 *
 * **Why these are not mapped onto this system's question flow.** A worker runs headless
 * (`--print` / `-p`): there is no user on the other end of the vendor's question tool and no
 * channel to put an answer back into the SAME process mid-call -- the child's stdin is closed, and
 * neither vendor offers a hook that can supply a tool's answer. Cursor refuses the call itself in
 * `--print` mode (measured 2026-09-21, 12:02 UTC: `askQuestion`, completed `result.rejected`), and
 * Cursor cannot pause mid-run at all (`canPauseMidRun: false`). This system's question flow
 * (`apps/orchestrator/src/ask.ts`) is a different shape entirely: the worker ENDS its run with a
 * `<slave-ask>` block naming a teammate or a role, the run parks `waiting_for_answer`, and the
 * answer arrives as the resumed session's prompt. A vendor question has no addressee in that
 * sense -- it is addressed to "the user" -- so turning one into an ask would mean inventing a
 * recipient the ask protocol deliberately refuses to guess (a role nobody holds is a task that
 * waits forever).
 *
 * **What is done instead.** The refusal is NOT a failed run: before this, the refused call landed
 * in `deniedToolUseIds` and `pump.ts` failed the whole run for it, spending an attempt on a worker
 * that did nothing wrong but ask. The pump now excuses a refused question the way it excuses a
 * permission-matrix refusal, the worker carries on with the refusal as its tool result, and the
 * implementation prompt's working rules tell it that there is no live user and to ask through the
 * `<slave-ask>` protocol instead.
 *
 * Claude's `AskUserQuestion` is listed for the same reason. Its headless refusal has not been
 * recorded; if it never surfaces as a `permission_denied` event, the entry is simply never matched.
 *
 * A TOTAL table keyed by `ProviderKind`, never an `===` on a vendor's name at the call site (the
 * M56a stage-8 rule): a third provider is a build error here, not a silent miss in the pump.
 */
export const USER_QUESTION_TOOLS: Readonly<Record<ProviderKind, readonly string[]>> = {
  claude_code: ['AskUserQuestion'],
  cursor: ['askQuestion'],
}

/** Whether `toolName` is `provider`'s own ask-the-user tool. */
export function isUserQuestionTool(provider: ProviderKind, toolName: string): boolean {
  return USER_QUESTION_TOOLS[provider].includes(toolName)
}
