import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requireExecutable, runIntegration } from '../../e2e/harness/run-context.mjs';
import { runOwnedTuiLab } from '../../e2e/harness/owned-tui-lab.mjs';

process.umask(0o077);
await runIntegration(import.meta.url, { testId: 'actual-native-target-owner-atomic-expected-turn-admission', tier: 'full-integration',
  modelPolicy: 'Two independent actual PTY/xterm Native owners and authenticated Gateway/device transport. Fixed loopback Provider holds real target turns; checks current, completed and cancelled expectedTurn selectors and original-CID receipts. No autonomous model, distinct OS user, Windows or external target claim.' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed actual-owner Native');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const { evidence, runRoot } = await runOwnedTuiLab(context, { binary, binarySha256,
    scenario: 'peer-sessions-gateway-expected-turn', description: 'actual-owner-held-current-ended-cancelled-original-receipt' });
  assert.equal(evidence.realPty, true); assert.equal(evidence.renderer, 'webgl');
  const facts = evidence.expectedTurnOwnerEvidence;
  assert.ok(facts.currentTurn && facts.cancelledTurn && facts.currentTurn !== facts.cancelledTurn);
  assert.equal(facts.receipt.messageId, facts.duplicate.messageId);
  assert.equal(facts.duplicate.status, 'applied');
  for (const receipt of [facts.ended, facts.cancelled]) {
    assert.equal(receipt.status, 'rejected'); assert.equal(receipt.reasonCode, 'target_turn_changed');
  }
  assert.equal(evidence.nativeHistoryPeerRows, 1);
  await context.writeArtifactJson('actual-target-owner-assertions.json', { ...evidence, binarySha256, nestedTuiRun: runRoot });
  return { actualTargetOwnerAtomicAdmission: true, currentAndCancelledSelectors: true, originalReceiptRetained: true, binarySha256 };
});
