// The application URL stays in the public signature for callers that still pass
// it; only http(s) pages are navigable, so its origin no longer matters.
export function normalizeBrowserUrl(value: string, appUrl?: string): string | null
export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withProtocol)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
