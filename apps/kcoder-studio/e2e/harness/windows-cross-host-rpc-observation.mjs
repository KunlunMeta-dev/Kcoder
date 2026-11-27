import assert from 'node:assert/strict';

const PREFIX = 'migration/sourceTransfer/internal/';
const CONSTANT_ERRORS = new Set(['source_transfer_busy', 'source_transfer_recovery_required', 'source_transfer_cancelled',
  'source_transfer_revision_conflict', 'source_transfer_source_changed', 'source_transfer_authority_changed',
  'source_transfer_owner_changed', 'source_transfer_request_changed', 'source_transfer_wrong_consumer',
  'source_transfer_invalid_manifest', 'source_transfer_invalid_peer', 'source_transfer_payload_changed',
  'source_transfer_capture_failed', 'source_transfer_selection_unavailable', 'migration_busy', 'migration_settings_busy']);

/** Observe only existing broker callbacks; params, successful results and arbitrary error text stay private. */
export function observeCrossHostNativeErrors(Broker, emit) {
  assert.equal(typeof Broker?.prototype?.sendInternalRequest, 'function'); assert.equal(typeof emit, 'function');
  const original = Broker.prototype.sendInternalRequest;
  function observed(method, params, fields = {}) {
    if (typeof method !== 'string' || !method.startsWith(PREFIX) || typeof fields.onResponse !== 'function') return original.call(this, method, params, fields);
    const callback = fields.onResponse;
    return original.call(this, method, params, { ...fields, onResponse: response => {
      try {
        if (response?.error) emit({ method, requestId: typeof params?.requestId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(params.requestId) ? params.requestId : null,
          code: Number.isSafeInteger(response.error.code) ? response.error.code : null,
          constant_error_message: CONSTANT_ERRORS.has(response.error.message) ? response.error.message : 'unclassified_native_error' });
      } catch { /* An observation failure must not consume or alter the original response. */ }
      return callback(response);
    } });
  }
  Broker.prototype.sendInternalRequest = observed;
  return () => { assert.equal(Broker.prototype.sendInternalRequest, observed); Broker.prototype.sendInternalRequest = original; };
}
