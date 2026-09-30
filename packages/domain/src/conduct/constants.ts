import { SUPERVISOR_PER_CALL_CAP_USD } from '../supervisor/constants.js'

/**
 * The role a question to the conductor is addressed to (spec R7). No seat ever holds it, so a
 * question to it is `unanswerable_question` the moment it is written, and the Supervisor's sourced
 * answer path -- the conductor's own voice -- answers it.
 */
export const CONDUCTOR_ROLE = 'conductor'

/**
 * The runtime role every package seat holds (plan decision D3). Package tasks require it; which
 * seat runs a package is decided by the pin (`SchedulableTask.pinnedSlaveId`), not by the role.
 */
export const PACKAGE_WORKER_ROLE = 'implementer'

/** The reserved key of the package that owns every path no other package matches (spec R3). */
export const INTEGRATION_PACKAGE_KEY = 'integration'

/**
 * The reserved key of the package that runs first and builds the runnable empty product every
 * other package builds on (skeleton spec S1). Every other package depends on it; it depends on nothing.
 */
export const SKELETON_PACKAGE_KEY = 'skeleton'

/** Failed conductor calls per goal version and stage before the fallback (plan decision D4). */
export const CONDUCT_RETRY_CAP = 3

/** One conductor call's budget: the Supervisor's per-call cap, for the same kind of call. */
export const CONDUCT_PER_CALL_CAP_USD = SUPERVISOR_PER_CALL_CAP_USD

/**
 * How long one conductor call may take (2026-09-29, first real project). The process default is
 * two minutes, sized for the Supervisor's short decisions; the size decision carries the goal, the
 * whole requirement set, a repository map and the catalogue, and an opus answer to it timed out at
 * two minutes on a ten-requirement goal. A conducted version has nothing else to do in its tick
 * until this answer arrives, so a longer wait costs nothing but the wait.
 */
export const CONDUCT_CALL_TIMEOUT_MS = 6 * 60_000

/** Spec R1: "1–60 items". */
export const REQUIREMENTS_MAX_ITEMS = 60

/** One requirement's text and source sentence, each; a longer one is a paragraph, not a check. */
export const REQUIREMENT_TEXT_MAX_CHARS = 600

/** The most packages the conductor may name in a partitioned answer. The validator may add the
 *  skeleton and the integration package on top (skeleton spec S1), so a plan holds up to two more. */
export const CONDUCT_MAX_PACKAGES = 8

/** The repository map lists at most this many files (the rest are counted, not listed). */
export const REPO_MAP_MAX_FILES = 2000

/** Files whose top-level symbols are read for the map; the rest are listed with their size only. */
export const REPO_MAP_SYMBOL_FILES_MAX = 400

/** The repository map's size in the conductor prompt. */
export const REPO_MAP_MAX_CHARS = 40_000

/** The catalogue summary's size in the conductor prompt. */
export const CONDUCT_CATALOGUE_MAX_CHARS = 30_000

/**
 * The runtime role a verification run's seat holds (Plan 4b decision D4). Never a package role: a
 * verifier implemented nothing in the goal version it verifies.
 */
export const VERIFIER_ROLE = 'verifier'

/** Verification runs of one round that produced no usable verdict before the round is given up on
 *  and the version goes `needs_human` (plan D7). */
export const VERIFICATION_RUN_RETRY_CAP = 3

/** `Workspace.verificationRoundCap`'s own default (spec R9) -- a version this many rounds deep with
 *  no acceptance goes `needs_human`. */
export const VERIFICATION_ROUND_CAP_DEFAULT = 3

/** One requirement's check text, as a person reads it back (spec R8) -- long enough for a real
 *  command or a short script, not a second copy of the repository. */
export const VERIFICATION_CHECK_MAX_CHARS = 8000

/** The evidence a person reads; a test run's full log stays in the scratch directory. */
export const VERIFICATION_OUTPUT_MAX_CHARS = 4000

/** One requirement's `fail`/`unverifiable` reason -- long enough to say why, short enough that a
 *  report of sixty items stays a report. */
export const VERIFICATION_REASON_MAX_CHARS = 2000

/** The integrated diff summary in the verification prompt -- the same order of size as the
 *  repository map, for the same reason: a diff worth verifying is not a paragraph. */
export const VERIFICATION_DIFF_STAT_MAX_CHARS = 20_000

/** The verifier's check, output and reason as they ride on a package's rework prompt (plan D5) --
 *  smaller than the verification prompt's own budget, because a worker reads this once per item. */
export const VERIFICATION_REWORK_MAX_CHARS = 6000

/** The tag a verification run's output is wrapped in (spec R8), the `SLAVE_REPORT_TAG` precedent:
 *  paired with `MARKERS` so quoted text in a transcript cannot forge or close one. */
export const SLAVE_VERIFICATION_TAG = 'slave-verification'

/** Skeleton spec S8: one package's leads in the verification prompt -- a report's questions and
 *  unfinished items, never its whole evidence. */
export const VERIFICATION_LEADS_PER_PACKAGE_MAX_CHARS = 1500

/** Skeleton spec S8: every package's leads together. */
export const VERIFICATION_LEADS_MAX_CHARS = 8000
