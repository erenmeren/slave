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

/** Failed conductor calls per goal version and stage before the fallback (plan decision D4). */
export const CONDUCT_RETRY_CAP = 3

/** One conductor call's budget: the Supervisor's per-call cap, for the same kind of call. */
export const CONDUCT_PER_CALL_CAP_USD = SUPERVISOR_PER_CALL_CAP_USD

/** Spec R1: "1–60 items". */
export const REQUIREMENTS_MAX_ITEMS = 60

/** One requirement's text and source sentence, each; a longer one is a paragraph, not a check. */
export const REQUIREMENT_TEXT_MAX_CHARS = 600

/** The most packages a partitioned goal may have, integration included. */
export const CONDUCT_MAX_PACKAGES = 8

/** The repository map lists at most this many files (the rest are counted, not listed). */
export const REPO_MAP_MAX_FILES = 2000

/** Files whose top-level symbols are read for the map; the rest are listed with their size only. */
export const REPO_MAP_SYMBOL_FILES_MAX = 400

/** The repository map's size in the conductor prompt. */
export const REPO_MAP_MAX_CHARS = 40_000

/** The catalogue summary's size in the conductor prompt. */
export const CONDUCT_CATALOGUE_MAX_CHARS = 30_000
