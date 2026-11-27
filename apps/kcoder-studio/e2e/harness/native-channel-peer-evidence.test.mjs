import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeChannelContinuationEvidence } from './native-channel-peer-evidence.mjs';

test('continuation requires exact two turns, SDK receipts and no foreign append', () => {
  const proof = 'OWNED_CHANNEL_TWO_TURN_PROOF model_calls=2 completed=2 final_sdk_receipts=2 foreign_ui_history_appends=0';
  assert.equal(parseNativeChannelContinuationEvidence('test ... '+proof+'\nok').completed, 2);
  for (const raw of ['', proof+'\n'+proof, proof.replace('model_calls=2','model_calls=1'), proof.replace('appends=0','appends=1'), 'x'.repeat(512*1024+1)]) {
    assert.throws(() => parseNativeChannelContinuationEvidence(raw));
  }
});
