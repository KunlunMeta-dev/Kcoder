import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPeerUidNative, pinPeerUidNative } from './native-input.mjs';

const plain = change => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 4096, uid: 0, mode: 0o100555, ...change });
test('foreign, linked and nonexecutable Native images fail before container use', () => {
  for (const change of [{ uid: 1000 }, { nlink: 2 }, { mode: 0o100444 }, { isSymbolicLink: () => true }]) assert.throws(() => assertPeerUidNative(plain(change)));
  assertPeerUidNative(plain({ mode: 0o100755 }));
});

test('actual file loading refuses a wrong SHA and retains the original input bytes', { skip: process.getuid?.() !== 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'peer-uid-image-'));
  const image = join(root, 'native'); const bytes = Buffer.from('Owned immutable image boundary');
  try {
    await writeFile(image, bytes, { mode: 0o755 });
    const expected = createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(pinPeerUidNative(image, '0'.repeat(64)));
    const pin = await pinPeerUidNative(image, expected); assert.equal(pin.sha256, expected);
  } finally { await rm(root, { recursive: true }); }
});
