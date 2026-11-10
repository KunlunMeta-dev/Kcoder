import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, truncate, link, rm, readdir, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { digestResource, resourceInventory, officeResourceManifestName, sameResourceFile } from './resource-verifier.mjs';

test('resource identity keeps descriptor volume and file replacement checks on Windows', () => {
  const held = {isFile:()=>true, nlink:1n, dev:7n, ino:9n, size:3n, mtimeNs:4n, ctimeNs:5n};
  const path = {...held, dev:0n};
  assert.equal(sameResourceFile(path, held), process.platform === 'win32');
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) {
    assert.equal(sameResourceFile(held, {...held, [field]:held[field] + 1n}), false, field);
  }
  assert.equal(sameResourceFile(path, {...held, ino:10n}), false);
});

test('complete native inventories preserve original directory order and all byte hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-inventory-'));
  try {
    await mkdir(join(root, 'a')); await mkdir(join(root, 'licenses'));
    const expected = [['a/first.txt', 'first'], ['a/second.txt', 'second'],
      ['a-file.txt', 'root'], ['licenses/LICENSE.txt', 'license'], ['z.txt', 'last']];
    for (const [path, text] of [...expected].reverse()) await writeFile(join(root, path), text);
    await writeFile(join(root, officeResourceManifestName), 'excluded own manifest');
    assert.deepEqual(await resourceInventory(root), {
      files: expected.map(([path, text]) => ({ path, bytes: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex'), legal: path.includes('LICENSE') })),
      totalBytes: expected.reduce((total, [, text]) => total + Buffer.byteLength(text), 0),
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aggregate bytes are rejected before a partially admitted inventory can publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-inventory-budget-'));
  try {
    for (const leaf of ['a', 'b']) { await writeFile(join(root, leaf), ''); await truncate(join(root, leaf), 128 * 1024 * 1024 + 1); }
    await assert.rejects(resourceInventory(root), { code: 'OFFICE_RESOURCE_LIMIT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed descriptor or cancellation never returns partial data or leaves owned FDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-inventory-failure-'));
  try {
    await writeFile(join(root, '0-hardlink'), 'unsafe'); await link(join(root, '0-hardlink'), join(root, 'linked'));
    for (let index = 0; index < 16; index++) await writeFile(join(root, `file-${index}`), Buffer.alloc(1024 * 1024, index));
    await assert.rejects(resourceInventory(root), { code: 'OFFICE_RESOURCE_UNSAFE' });
    if (process.platform === 'linux') {
      const fds = await readdir('/proc/self/fd');
      const targets = await Promise.all(fds.map(fd => readlink('/proc/self/fd/' + fd).catch(() => '')));
      assert.deepEqual(targets.filter(path => path.startsWith(root + '/')), []);
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resourceInventory(root, { signal: controller.signal }), { code: 'OFFICE_CANCELLED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a real file appended on every read check stops at its first oversized chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-growing-resource-'));
  try {
    const path = join(root, 'growing'); await writeFile(path, 'original');
    let checks = 0;
    const signal = { get aborted() {
      if (++checks > 4) throw Error('Test safety fence: growing read did not stop');
      appendFileSync(path, Buffer.alloc(256 * 1024, checks));
      return false;
    } };
    await assert.rejects(digestResource(path, { maxBytes: 8, signal }), { code: 'OFFICE_RESOURCE_CHANGED' });
    assert.equal(checks, 1, 'No second read may follow an oversized first chunk');
    if (process.platform === 'linux') {
      const fds = await readdir('/proc/self/fd');
      const targets = await Promise.all(fds.map(fd => readlink('/proc/self/fd/' + fd).catch(() => '')));
      assert.deepEqual(targets.filter(value => value === path), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
