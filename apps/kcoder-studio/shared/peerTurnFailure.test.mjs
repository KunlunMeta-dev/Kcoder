import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { peerTurnFailure, PEER_TURN_AUTHORIZATION_CODES } from './peerTurnFailure.ts';
const peer = 'peer-2-12345678-1234-1234-1234-123456789abc';
const legacy = 'Provider main request failed (Provider error: unknown_error. Response details withheld.)';
const providerFailure = { category: 'provider_error', recovery_action: 'diagnose_only', retryable: false, resume_safe: false };
test('a new finite local peer reason is not a model failure or a replay grant', () => {
  assert.deepEqual(peerTurnFailure({ error: 'KCoder peer turn authorization failed [peer_provider_start_owner_changed]' }),
    { kind: 'authorization', reason: 'peer_provider_start_owner_changed' });
  assert.equal(peerTurnFailure({ error: 'KCoder peer turn authorization failed [PRIVATE_PATH_OR_SECRET]' }), undefined);
});
test('only the old exact peer automatic identity and unknown Provider record get neutral missing-cause presentation', () => {
  assert.deepEqual(peerTurnFailure({ error: legacy, providerFailure, turnId: peer }), { kind: 'legacy_unknown' });
  for (const turnId of ['turn-2', 'peer-human-session', 'automation-2-12345678-1234-1234-1234-123456789abc'])
    assert.equal(peerTurnFailure({ error: legacy, providerFailure, turnId }), undefined);
  assert.equal(peerTurnFailure({ error: legacy, turnId: peer }), undefined);
  assert.equal(peerTurnFailure({ error: 'Provider model unavailable', providerFailure, turnId: peer }), undefined);
});
test('actual HTTP and ordinary model failures retain their original presentation', () => {
  assert.equal(peerTurnFailure({ error: legacy, providerFailure: { ...providerFailure, http_status: 503 }, turnId: peer }), undefined);
  assert.equal(peerTurnFailure({ error: 'Provider error: unknown_error; HTTP 500. Response details withheld.', providerFailure, turnId: peer }), undefined);
  assert.equal(peerTurnFailure({ error: 'KCoder peer turn authorization failed [peer_provider_start_owner_changed]', providerFailure: { ...providerFailure, http_status: 403 } }), undefined);
});

test('the client safe reason set stays identical to the Native summary constructor', async () => {
  const rust = await readFile(new URL('../../../crates/kcoder_types/src/provider_error_summary.rs', import.meta.url), 'utf8');
  const method = rust.split('pub fn peer_turn_authorization')[1].split('pub fn as_str')[0];
  const reasons = [...method.matchAll(/"([a-z][a-z0-9_]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(PEER_TURN_AUTHORIZATION_CODES)].sort(), [...new Set(reasons)].sort());
});
