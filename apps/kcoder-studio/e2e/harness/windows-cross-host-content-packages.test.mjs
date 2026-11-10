import assert from 'node:assert/strict';
import test from 'node:test';
import { crossHostInstructionMappings, prepareCrossHostPackageTransfers, CROSS_HOST_INSTRUCTION_TARGETS } from './windows-cross-host-content-packages.mjs';

test('instruction maps use explicit known target directories and refuse an unobserved or arbitrary scope', () => {
  const rows = [{ itemId: 'root', relativeScope: '', disposition: 'selected', completeAuthorizedStaticChain: true },
    { itemId: 'child', relativeScope: 'child', disposition: 'selected', completeAuthorizedStaticChain: true },
    { itemId: 'empty', disposition: 'empty' }];
  assert.deepEqual(crossHostInstructionMappings(rows, 'codex', 'e0000-0000'), { entryId: 'e0000-0000', items: [
    { itemId: 'root', targetRelativeScope: CROSS_HOST_INSTRUCTION_TARGETS.codex[''] },
    { itemId: 'child', targetRelativeScope: CROSS_HOST_INSTRUCTION_TARGETS.codex.child },
  ] });
  assert.throws(() => crossHostInstructionMappings([{ ...rows[0], relativeScope: '../../outside' }, rows[1]], 'codex', 'e0000-0000'), /unreviewed source scope/);
  assert.throws(() => crossHostInstructionMappings([{ ...rows[0], completeAuthorizedStaticChain: false }, rows[1]], 'codex', 'e0000-0000'));
  assert.throws(() => crossHostInstructionMappings(rows, 'unknown', 'e0000-0000'));
});

test('an older graph or plugin peer is rejected before any source capture mutation', async () => {
  const full = { migrationInstructionSourcesV1: true, migrationSourceTransferInstructionsV1: true, migrationLocalPluginsV1: true, migrationSourceTransferPluginsV1: true };
  for (const peer of ['source', 'target']) for (const field of Object.keys(full)) {
    const capabilities = { source: { ...full }, target: { ...full } }; capabilities[peer][field] = false;
    await assert.rejects(prepareCrossHostPackageTransfers({ capabilities, call: () => assert.fail('unsupported target must not start a capture') }), /UNMET_PREREQUISITE/);
  }
});

test('capture replies must keep the original explicit capture identity and cannot become a guessed transfer', async () => {
  const full = { migrationInstructionSourcesV1: true, migrationSourceTransferInstructionsV1: true, migrationLocalPluginsV1: true, migrationSourceTransferPluginsV1: true };
  const calls = [];
  await assert.rejects(prepareCrossHostPackageTransfers({ capabilities: { source: full, target: full }, metadata: { instructionRoots: { 'claude-code': '/owned/source' } },
    openPair: async () => ({ source: { sessionId: 'original-instruction-source' }, target: {} }), closePair: async () => {},
    call: async (lane, operation, params) => { calls.push([lane, operation, params.query.kind]); return { captureId: 'another-capture' }; },
  }));
  assert.deepEqual(calls, [['source-session', 'query', 'instructions_capture']]);
});
