import assert from 'node:assert/strict';

export function parseNativeChannelContinuationEvidence(transcript) {
  assert.equal(typeof transcript, 'string');
  assert.ok(Buffer.byteLength(transcript) <= 512 * 1024, 'Native protocol transcript exceeded bound');
  const observations = transcript.match(/OWNED_CHANNEL_TWO_TURN_PROOF[^\r\n]*/g) || [];
  assert.equal(observations.length, 1, 'Exactly one original continuation proof is required');
  assert.equal(observations[0], 'OWNED_CHANNEL_TWO_TURN_PROOF model_calls=2 completed=2 final_sdk_receipts=2 foreign_ui_history_appends=0');
  return { modelCalls: 2, completed: 2, finalSdkReceipts: 2, foreignUiHistoryAppends: 0 };
}
