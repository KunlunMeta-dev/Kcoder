import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeIcns, generateDesktopIcons } from './generate-icons.mjs';

test('ICNS canonicalization preserves payloads and rejects malformed containers', () => {
  const chunk = type => Buffer.concat([Buffer.from(type), Buffer.from([0, 0, 0, 9, 42])]);
  const header = Buffer.concat([Buffer.from('icns'), Buffer.from([0, 0, 0, 26])]);
  const canonical = Buffer.concat([header, chunk('ic07'), chunk('ic08')]);
  assert.deepEqual(canonicalizeIcns(Buffer.concat([header, chunk('ic08'), chunk('ic07')])), canonical);
  assert.deepEqual(canonicalizeIcns(canonical), canonical);
  assert.throws(() => canonicalizeIcns(canonical.subarray(0, 25)), /Invalid ICNS/);
  const invalid = Buffer.from(canonical);
  invalid.writeUInt32BE(0, 12);
  assert.throws(() => canonicalizeIcns(invalid), /Invalid ICNS chunk length/);
});

test('committed desktop and browser icon inventory matches its source and hashes', async () => {
  const result = await generateDesktopIcons({ check: true });
  assert.equal(result.files, 9);
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
});

async function ownedInventory(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-icon-derivation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(join(studio, 'desktop/icon-assets.json'), 'utf8'));
  for (const path of [...Object.keys(manifest.files), 'desktop/icon-assets.json']) {
    const inside = relative(studio, resolve(studio, path));
    assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`));
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(studio, path), join(root, path));
  }
  return { root, manifest };
}

test('a self-consistent manifest cannot turn the Linux derivative into the full source image', async t => {
  const { root, manifest } = await ownedInventory(t);
  const input = await readFile(new URL('../../../logo/icon.png', import.meta.url));
  await writeFile(join(root, 'desktop/icons/icon.png'), input);
  manifest.files['desktop/icons/icon.png'] = createHash('sha256').update(input).digest('hex');
  await writeFile(join(root, 'desktop/icon-assets.json'), JSON.stringify(manifest));
  await assert.rejects(generateDesktopIcons({ check: true, targetRoot: root }), /512x512 derivative/);
});
