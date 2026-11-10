import assert from 'node:assert/strict';
import test from 'node:test';
import { ownedWindowsEvidencePath, runtimeSeedAttachmentDescriptors } from './windows-local-attachment-case.mjs';

test('owned Windows evidence accepts equivalent local NT namespace paths without extending the owner root', () => {
  const root = 'D:\\owned fixture';
  for (const path of ['D:\\owned fixture\\history\\a.jsonl', '\\\\?\\D:\\owned fixture\\history\\a.jsonl',
    'd:\\OWNED FIXTURE\\history\\a.jsonl']) assert.equal(ownedWindowsEvidencePath(root, path), path);
  assert.equal(ownedWindowsEvidencePath('\\\\?\\D:\\owned fixture', 'D:\\owned fixture\\artifact.bin'), 'D:\\owned fixture\\artifact.bin');
});

test('runtime seed inspection consumes flattened State records and does not confuse nested vendor or visible user messages', () => {
  const descriptor = { historicalContentVerified: false, provenance: { kind: 'user_supplied_local', operationId: 'owned-operation' } };
  const seed = { session_id: 'Ab123', timestamp_ms: 1, role: 'user', origin: 'runtime',
    content: [{ type: 'text', text: 'Inert historical evidence' },
      { type: 'text', text: JSON.stringify({ historical_attachment: descriptor }) }] };
  assert.deepEqual(runtimeSeedAttachmentDescriptors([seed, { role: 'user', origin: 'user', content: [] }]), [descriptor]);
  assert.throws(() => runtimeSeedAttachmentDescriptors([{ message: seed }]));
  assert.throws(() => runtimeSeedAttachmentDescriptors([{ ...seed, origin: 'user' }]));
  assert.throws(() => runtimeSeedAttachmentDescriptors([seed, seed]));
});

test('evidence rejects parent, peer, drive, UNC, device and alternate-data-stream escapes before any read', () => {
  for (const path of ['D:\\owned fixture', 'D:\\owned fixture\\..\\personal\\a',
    'D:\\owned fixture-peer\\a', 'C:\\owned fixture\\a', '\\\\?\\C:\\owned fixture\\a',
    '\\\\server\\share\\a', '\\\\?\\UNC\\server\\share\\a', '\\\\.\\D:\\owned fixture\\a',
    'D:\\owned fixture\\a:hidden', 'relative.json', 'D:\\owned fixture\\a\n'])
    assert.throws(() => ownedWindowsEvidencePath('D:\\owned fixture', path));
});
