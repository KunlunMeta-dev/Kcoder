import { expect, test } from 'vitest'
import { providerRetryDiagnostics } from './providerRetryDiagnostics'

test('only existing bounded previous-attempt facts survive projection', () => {
  const projected = providerRetryDiagnostics({ reason: 'request_timeout', timeout_kind: 'token_idle', provider: 'Baize', model: 'owned/model',
    elapsed_ms: 1200, transport_elapsed_ms: 1000, turn_elapsed_ms: 2000, first_token_ms: 100, last_token_ms: 500,
    text: 'RAW_NOTICE_MUST_NOT_SURVIVE', headers: { authorization: 'RAW_HEADER' }, prompt: 'RAW_PROMPT' })
  expect(projected).toEqual({ reason: 'request_timeout', timeoutKind: 'token_idle', provider: 'Baize', model: 'owned/model',
    previousAttemptElapsedMs: 1200, previousTransportElapsedMs: 1000, turnElapsedMsAtFailure: 2000, previousFirstTokenMs: 100, previousLastTokenMs: 500 })
  expect(JSON.stringify(projected)).not.toMatch(/RAW_NOTICE|RAW_HEADER|RAW_PROMPT/)
})
test('credentials, URL userinfo and sensitive queries are removed before display metadata is retained', () => {
  const projected = providerRetryDiagnostics({ reason: '\u001b[31msk-0123456789abcdefghijkl api_key="OWNED_KEY_VALUE" https://user:OWNED_PASSWORD@owned.invalid/path?token=OWNED_TOKEN',
    provider: 'Bearer OWNED_BEARER_VALUE', model: 'wss://user:OWNED_WS_PASSWORD@owned.invalid/model?secret=OWNED_WS_TOKEN' })
  expect(JSON.stringify(projected)).not.toMatch(/0123456789abcdefghijkl|OWNED_KEY_VALUE|OWNED_PASSWORD|OWNED_TOKEN|OWNED_BEARER_VALUE|OWNED_WS_PASSWORD|OWNED_WS_TOKEN/)
  expect(projected?.reason).toContain('[REDACTED]')
  expect(projected?.model).toBe('[URL]')
})
test('pasted bodies, oversized values and malformed timings do not become retry diagnostics', () => {
  expect(providerRetryDiagnostics({ reason: '{"headers":{"authorization":"PRIVATE"},"prompt":"PRIVATE_PROMPT"}', provider: 'p'.repeat(2049),
    model: { secret: 'PRIVATE' }, elapsed_ms: NaN, transport_elapsed_ms: -1, turn_elapsed_ms: Infinity, first_token_ms: 1.5, last_token_ms: 604800001 })).toBeUndefined()
})
