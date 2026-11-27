function redactDiagnosticText(value: string) {
  return value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD').replaceAll('\0', '')
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|bgw_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [REDACTED]')
    // A key may start only at a boundary; otherwise a long identifier scans every suffix again.
    .replace(/(?<![A-Za-z0-9_])(["']?(?:[A-Z0-9_]*(?:API_KEY|PASSWORD|PASSWD|ACCESS_TOKEN|REFRESH_TOKEN|SECRET)|api[_-]?key|authorization|cookie|set-cookie|password|passwd|access[_-]?token|refresh[_-]?token|private[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi, '$1"[REDACTED]"')
    .replace(/([?&](?:token|key|api_key|access_token|secret|password)=)[^\s&#"']*/gi, '$1[REDACTED]');
}

export interface ProviderRetryDiagnostics {
  reason?: string
  timeoutKind?: string
  provider?: string
  model?: string
  previousAttemptElapsedMs?: number
  previousTransportElapsedMs?: number
  turnElapsedMsAtFailure?: number
  previousFirstTokenMs?: number
  previousLastTokenMs?: number
}
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  // eslint-disable-next-line no-control-regex -- Remove terminal color escapes before credential matching.
  const normalized = value.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '')
  // Retry fields are display metadata. Never retain a pasted request or headers.
  if (/\b(?:headers|prompt|messages|request_body)\b[\s\\"']*[:=]/iu.test(normalized)) return undefined
  const withoutUrls = normalized.replace(/[A-Za-z][A-Za-z0-9+.-]{0,20}:\/\/[^\s<>"']+/gu, '[URL]')
  const safe = redactDiagnosticText(withoutUrls)
    // eslint-disable-next-line no-control-regex -- Control and bidi characters are not diagnostic content.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .trim().slice(0, limit)
  return safe || undefined
}
const milliseconds = (value: unknown): number | undefined => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0 && value <= 604800000 ? value : undefined

/** Pick the existing retry event's bounded facts; never store raw notice text. */
export function providerRetryDiagnostics(event: Record<string, unknown>): ProviderRetryDiagnostics | undefined {
  const result: ProviderRetryDiagnostics = {}
  const strings = { reason: text(event.reason, 512), timeoutKind: text(event.timeout_kind, 64),
    provider: text(event.provider, 256), model: text(event.model, 256) }
  const times = { previousAttemptElapsedMs: milliseconds(event.elapsed_ms),
    previousTransportElapsedMs: milliseconds(event.transport_elapsed_ms),
    turnElapsedMsAtFailure: milliseconds(event.turn_elapsed_ms),
    previousFirstTokenMs: milliseconds(event.first_token_ms), previousLastTokenMs: milliseconds(event.last_token_ms) }
  for (const [key, value] of Object.entries({ ...strings, ...times })) if (value !== undefined) Object.assign(result, { [key]: value })
  return Object.keys(result).length ? result : undefined
}
