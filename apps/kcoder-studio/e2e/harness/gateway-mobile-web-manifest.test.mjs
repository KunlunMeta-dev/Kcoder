import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildGatewayMobileWebManifest,
  MOBILE_WEB_BASE_TOKEN,
  writeGatewayMobileWebManifest,
} from '../../mobile/scripts/gateway-mobile-web-manifest.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function withRoot(body) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-mobile-manifest-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('builds the mounted-manifest rows from the exact copied bundle bytes', async () => {
  await withRoot(async root => {
    await mkdir(join(root, '_expo'), { mode: 0o700 });
    await mkdir(join(root, 'assets'), { mode: 0o700 });
    const resources = new Map([
      ['index.html', Buffer.from(`<script src="${MOBILE_WEB_BASE_TOKEN}/_expo/static/js/web/app.js"></script>`, 'utf8')],
      ['_expo/.routes.json', Buffer.from('{}', 'utf8')],
      ['assets/app.js', Buffer.from(`globalThis.base = ${JSON.stringify(MOBILE_WEB_BASE_TOKEN)};`, 'utf8')],
      ['assets/icon.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])],
    ]);
    for (const [path, bytes] of resources) {
      await writeFile(join(root, path), bytes, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(join(root, 'kcoder-mobile-web.json'), 'stale manifest', { mode: 0o600 });
    const expectedFiles = [...resources]
      .map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const manifest = await buildGatewayMobileWebManifest(root, { expectedFiles });
    assert.deepEqual(Object.keys(manifest).sort(), ['baseToken', 'files', 'version']);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.baseToken, MOBILE_WEB_BASE_TOKEN);
    assert.deepEqual(manifest.files.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })), expectedFiles);
    assert.equal(manifest.files.find(row => row.path === 'index.html').replacements, 1);
    assert.equal(manifest.files.find(row => row.path === 'assets/app.js').replacements, 1);
    assert.equal(manifest.files.find(row => row.path === 'assets/icon.bin').text, false);
    assert.equal(manifest.files.find(row => row.path === 'assets/icon.bin').replacements, 0);
    await writeGatewayMobileWebManifest(root, manifest);
    assert.equal(await readFile(join(root, 'kcoder-mobile-web.json'), 'utf8'), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.kcoder-mobile-web-manifest-')), []);
  });
});

test('rejects a manifest that does not match the pinned bundle file table', async () => {
  await withRoot(async root => {
    await writeFile(join(root, 'index.html'), `<main>${MOBILE_WEB_BASE_TOKEN}</main>`, { mode: 0o600 });
    await assert.rejects(buildGatewayMobileWebManifest(root, { expectedFiles: [] }), /pinned matched bundle/);
  });
});

test('rejects missing mount tokens, binary tokens, invalid UTF-8, and HTML integrity attributes', async t => {
  const badBundles = [
    ['missing mount token', Buffer.from('<main>no mount base</main>'), null],
    ['binary token', Buffer.from(`${MOBILE_WEB_BASE_TOKEN}\0`, 'binary'), 'asset.bin'],
    ['invalid UTF-8', Buffer.from([0x3c, 0x25, 0xff, 0x3e]), null],
    ['HTML integrity attribute', Buffer.from(`<script integrity="sha256-x">${MOBILE_WEB_BASE_TOKEN}</script>`), null],
  ];
  for (const [label, indexBytes, extraName] of badBundles) {
    await t.test(label, async () => withRoot(async root => {
      await writeFile(join(root, 'index.html'), indexBytes, { mode: 0o600 });
      if (extraName) await writeFile(join(root, extraName), Buffer.from(`${MOBILE_WEB_BASE_TOKEN}\0`, 'binary'), { mode: 0o600 });
      await assert.rejects(buildGatewayMobileWebManifest(root));
    }));
  }
});

test('rejects symlinked resources and unsupported path characters', async t => {
  await t.test('symlink', async () => withRoot(async root => {
    await writeFile(join(root, 'index.html'), `<main>${MOBILE_WEB_BASE_TOKEN}</main>`, { mode: 0o600 });
    await writeFile(join(root, 'app.js'), `${MOBILE_WEB_BASE_TOKEN}`, { mode: 0o600 });
    await symlink(join(root, 'app.js'), join(root, 'alias.js'));
    await assert.rejects(buildGatewayMobileWebManifest(root), /Unsupported Mobile Web resource/);
  }));
  await t.test('unsafe name', async () => withRoot(async root => {
    await writeFile(join(root, 'index.html'), `<main>${MOBILE_WEB_BASE_TOKEN}</main>`, { mode: 0o600 });
    await writeFile(join(root, 'bad?name.js'), `${MOBILE_WEB_BASE_TOKEN}`, { mode: 0o600 });
    await assert.rejects(buildGatewayMobileWebManifest(root), /Unsupported Mobile Web resource/);
  }));
});

test('rejects resource paths longer than the static handler accepts', async () => {
  await withRoot(async root => {
    await writeFile(join(root, 'index.html'), `<main>${MOBILE_WEB_BASE_TOKEN}</main>`, { mode: 0o600 });
    let directory = root;
    for (let index = 0; index < 5; index += 1) {
      directory = join(directory, 'd'.repeat(200));
      await mkdir(directory, { mode: 0o700 });
    }
    await writeFile(join(directory, 'resource-name-long-enough-to-exceed-the-handler-limit.js'), 'x', { mode: 0o600 });
    await assert.rejects(buildGatewayMobileWebManifest(root), /resource path exceeds static handler limit/);
  });
});

test('rejects a pretty-printed manifest larger than the static handler byte limit', async () => {
  await withRoot(async root => {
    await writeFile(join(root, 'index.html'), `<main>${MOBILE_WEB_BASE_TOKEN}</main>`, { mode: 0o600 });
    let directory = root;
    for (const name of ['a'.repeat(200), 'b'.repeat(200)]) {
      directory = join(directory, name);
      await mkdir(directory, { mode: 0o700 });
    }
    const fileCount = 8800;
    const representativeResourcePath = `${'a'.repeat(200)}/${'b'.repeat(200)}/resource-00000.txt`;
    assert.ok(representativeResourcePath.length < 1024, 'oversize-manifest fixture paths must remain legal handler paths');
    assert.ok(fileCount + 1 < 10000, 'oversize-manifest fixture must stay below the file-count limit');
    for (let offset = 0; offset < fileCount; offset += 400) {
      const batch = Array.from({ length: Math.min(400, fileCount - offset) }, (_, item) => offset + item);
      await Promise.all(batch.map(index => writeFile(
        join(directory, `resource-${index.toString(36).padStart(5, '0')}.txt`),
        'x',
        { mode: 0o600 },
      )));
    }
    await assert.rejects(buildGatewayMobileWebManifest(root), /manifest exceeds static handler limit/);
  });
});

test('rejects symlinked and hard-linked manifest destinations without changing their external target', async t => {
  const cases = [
    ['symlink', symlink],
    ['hard link', link],
  ];
  for (const [label, createLink] of cases) {
    await t.test(label, async () => withRoot(async root => {
      await writeFile(join(root, 'index.html'), `<main>${MOBILE_WEB_BASE_TOKEN}</main>`, { mode: 0o600 });
      const externalRoot = await mkdtemp(join(tmpdir(), 'gateway-mobile-manifest-outside-'));
      const outside = join(externalRoot, 'sentinel.json');
      const destination = join(root, 'kcoder-mobile-web.json');
      const original = Buffer.from('outside bytes must remain unchanged');
      try {
        await writeFile(outside, original, { mode: 0o600 });
        await createLink(outside, destination);
        const manifest = { version: 1, baseToken: MOBILE_WEB_BASE_TOKEN, files: [] };
        await assert.rejects(buildGatewayMobileWebManifest(root), /Unsafe existing Mobile Web manifest destination/);
        await assert.rejects(writeGatewayMobileWebManifest(root, manifest), /Unsafe existing Mobile Web manifest destination/);
        assert.deepEqual(await readFile(outside), original);
        const destinationInfo = await lstat(destination);
        assert.equal(destinationInfo.isSymbolicLink(), label === 'symlink');
        assert.equal(destinationInfo.nlink, label === 'hard link' ? 2 : 1);
      } finally {
        await rm(externalRoot, { recursive: true, force: true });
      }
    }));
  }
});
