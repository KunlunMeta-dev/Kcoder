/** Display the schedule's actual time zone, independently of the browser host's zone. */
export function formatAutomationTimestamp(
  epochMs: number,
  locale: string,
  timezone?: string
): string | undefined {
  if (!Number.isFinite(epochMs) || epochMs < 0) return undefined
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
      timeZoneName: 'short',
    }).format(new Date(epochMs))
  } catch {
    return undefined
  }
}
