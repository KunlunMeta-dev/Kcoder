import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createImagePasteFixture,
  imagePasteKeyForPlatform,
} from '../lib/image-paste-fixture.mjs';

test('uses a terminal-safe image paste shortcut on each platform', () => {
  assert.equal(imagePasteKeyForPlatform('linux'), 'Control+Alt+V');
  assert.equal(imagePasteKeyForPlatform('darwin'), 'Control+Alt+V');
  assert.equal(imagePasteKeyForPlatform('win32'), 'Alt+V');
});

test('creates a private PNG fixture inside the run directory', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'kcoder-tui-lab-image-'));
  try {
    const fixture = await createImagePasteFixture(runDir);
    const bytes = await readFile(fixture.path);
    const metadata = await stat(fixture.path);

    assert.equal(path.dirname(fixture.path), runDir);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(fixture.byteLength, bytes.length);
    if (process.platform !== 'win32') {
      assert.equal(metadata.mode & 0o777, 0o600);
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
