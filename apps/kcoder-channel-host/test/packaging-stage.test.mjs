import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { stageConnectivityResources } from '../packaging/stage-resources.mjs';

const manifest = JSON.stringify({ schemaVersion: 1, name: '@kunlunmeta/kcoder-channel-host' });
async function stageBundle({ output }) {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'channel-resource-manifest.json'), manifest);
  await writeFile(join(output, 'resource'), 'new-owned-bytes');
  return { manifestSha256: 'a'.repeat(64) };
}
async function fixture(t, owned = true) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-channel-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'component');
  await mkdir(destination);
  await writeFile(join(destination, 'resource'), 'original-bytes');
  if (owned) await writeFile(join(destination, 'channel-resource-manifest.json'), manifest);
  return { root, destination };
}

test('an existing directory without the owned manifest is never replaced', async t => {
  const { destination } = await fixture(t, false);
  let staged = false;
  await assert.rejects(stageConnectivityResources({ destination, replace: true,
    stageBundle: async () => { staged = true; throw new Error('must not prepare replacement'); },
  }), /CHANNEL_STAGE_DESTINATION_NOT_OWNED/);
  assert.equal(staged, false);
  assert.equal(await readFile(join(destination, 'resource'), 'utf8'), 'original-bytes');
});

test('a failed publication restores the previous component', async t => {
  const { destination } = await fixture(t);
  await assert.rejects(stageConnectivityResources({ destination, replace: true, stageBundle,
    renamePath: async (from, to) => {
      if (basename(from) === 'component' && to === destination && from !== destination)
        throw Object.assign(new Error('synthetic publication failure'), { code: 'EACCES' });
      return rename(from, to);
    },
  }), /synthetic publication failure/);
  assert.equal(await readFile(join(destination, 'resource'), 'utf8'), 'original-bytes');
});

test('successful publication retains the previous generated component as evidence', async t => {
  const { root, destination } = await fixture(t);
  await stageConnectivityResources({ destination, replace: true, stageBundle });
  assert.equal(await readFile(join(destination, 'resource'), 'utf8'), 'new-owned-bytes');
  const previous = (await readdir(root)).find(name => name.startsWith('component.previous-'));
  assert.ok(previous);
  assert.equal(await readFile(join(root, previous, 'resource'), 'utf8'), 'original-bytes');
});

test('a destination replaced while resources are prepared is preserved', async t => {
  const { destination } = await fixture(t);
  await assert.rejects(stageConnectivityResources({ destination, replace: true,
    stageBundle: async options => {
      await rename(destination, destination + '.peer-replaced');
      await mkdir(destination);
      await writeFile(join(destination, 'resource'), 'peer-bytes');
      return stageBundle(options);
    },
  }), /CHANNEL_STAGE_DESTINATION_CHANGED/);
  assert.equal(await readFile(join(destination, 'resource'), 'utf8'), 'peer-bytes');
});

test('a blocked rollback preserves both a peer destination and the previous component', async t => {
  const { root, destination } = await fixture(t);
  await assert.rejects(stageConnectivityResources({ destination, replace: true, stageBundle,
    renamePath: async (from, to) => {
      if (basename(from) === 'component' && to === destination && from !== destination) {
        await mkdir(destination);
        await writeFile(join(destination, 'resource'), 'peer-bytes');
        throw new Error('synthetic publication failure');
      }
      return rename(from, to);
    },
  }), /CHANNEL_STAGE_PUBLISH_AND_ROLLBACK_FAILED/);
  assert.equal(await readFile(join(destination, 'resource'), 'utf8'), 'peer-bytes');
  const previous = (await readdir(root)).find(name => name.startsWith('component.previous-'));
  assert.equal(await readFile(join(root, previous, 'resource'), 'utf8'), 'original-bytes');
});
