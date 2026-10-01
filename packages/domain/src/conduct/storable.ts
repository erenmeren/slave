/**
 * Storable text (spec §5): what Postgres will keep in `text` and `jsonb`. Its own module so that
 * `requirements.ts`, which `verification.ts` imports, can use it without an import cycle.
 */

/** Every C0 control but tab and newline; `\r` too, so a CRLF reads as one newline. */
const UNSTORABLE_CONTROLS = /[\u0000-\u0008\u000B-\u001F]/gu
/** A surrogate half without its other half (JavaScript strings can hold one; UTF-8 cannot). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu

/**
 * Text a process or a worker produced, made storable (final review I2): Postgres refuses a NUL
 * byte in `text` and in `jsonb` alike, and a lone surrogate half in `jsonb`. A smoke script that
 * printed one made its attempt's record throw on every pass, until the attempt was settled as
 * "the process is gone" -- a pass included. The other C0 controls (terminal colours, bells) go
 * too: nobody reading the page or a rework prompt is helped by them. Tabs and newlines stay.
 */
export function storableText(text: string): string {
  return text.replace(UNSTORABLE_CONTROLS, '').replace(LONE_SURROGATE, '\uFFFD')
}

/**
 * A `JSON.parse` reviver that makes every string of a model's or a worker's answer storable as it
 * is read (Task 6), shared by `parseSlaveReport`, `parseConductAnswer` and `parseRequirementsAnswer`:
 * each answer is stored as jsonb, which refuses a `\u0000` escape (22P05), before anything else
 * reads it.
 */
export function storableJsonReviver(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? storableText(value) : value
}
