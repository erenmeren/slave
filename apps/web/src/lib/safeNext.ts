/** The login page's `next` parameter is honoured only as a same-origin relative path: it must
 *  start with `/` and not with `//` or `/\` (both of which browsers read as protocol-relative).
 *  Anything else — an absolute URL, a bare segment, nothing — falls back to `/`. */
export function safeNext(value: string | null): string {
  if (value === null || !value.startsWith('/')) return '/'
  if (value.startsWith('//') || value.startsWith('/\\')) return '/'
  return value
}
