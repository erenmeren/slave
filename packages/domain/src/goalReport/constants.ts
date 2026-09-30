/** Conductor Plan 5 (spec R10): the bounds and names the goal-version report shares. */

/** Files one package merge records on its `task.done` (plan D3). A merge that touched more says
 *  how many (`filesTotal`), and the report says the list is cut. */
export const GOAL_REPORT_FILES_MAX = 500

/** The decision trail's length (plan D6): the newest entries are kept, and the report says how
 *  many older ones were left out. */
export const GOAL_REPORT_TRAIL_MAX = 1000

/** Denied tool calls one report lists (skeleton spec S9, plan B D10): a run that loops on a refused
 *  tool can write hundreds; the report keeps the oldest and says how many more there were. */
export const GOAL_REPORT_DENIALS_MAX = 200

/** One trail entry's quoted text. A verification rework reason carries the verifier's evidence
 *  (up to `VERIFICATION_REWORK_MAX_CHARS`), so this is the same order of size. */
export const GOAL_REPORT_DETAIL_MAX_CHARS = 6000

/** The chat note's length (plan D10): a summary that points at the report, never the report. */
export const GOAL_REPORT_SUMMARY_MAX_CHARS = 1500

/** The prefix of every chat note's `SupervisorMessage.noteKey` (plan D10). */
export const GOAL_REPORT_NOTE_KEY_PREFIX = 'goal-report:'
