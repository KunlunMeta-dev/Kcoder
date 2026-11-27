/** Presentation-only text: bounded plain strings, never markup or invocation identity. */
export function normalizeToolDisplayText(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [locale, text] of Object.entries(value).slice(0, 8)) {
    if (typeof text !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]{0,31}$/.test(locale)) continue
    const bounded = Array.from(text.replace(/\p{Cc}/gu, '').trim()).slice(0, 128).join('')
    if (bounded) result[locale] = bounded
  }
  return Object.keys(result).length ? result : undefined
}
