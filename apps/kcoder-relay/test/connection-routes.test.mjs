import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const relayRoot = fileURLToPath(new URL('../', import.meta.url));
const canonicalSource = join(relayRoot, '../kcoder-studio/shared/gatewayConnectionRoutes.js');

async function runtimeTree(t, { canonical = true, malformedCanonical = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-relay-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'apps', 'kcoder-relay', 'src');
  const sharedDirectory = join(root, 'apps', 'kcoder-studio', 'shared');
  await mkdir(sourceDirectory, { recursive: true });
  await copyFile(join(relayRoot, 'src', 'connection-routes.mjs'), join(sourceDirectory, 'connection-routes.mjs'));
  await copyFile(canonicalSource, join(sourceDirectory, 'gatewayConnectionRoutes.runtime.mjs'));
  if (canonical) {
    await mkdir(sharedDirectory, { recursive: true });
    await writeFile(join(root, 'apps', 'kcoder-studio', 'package.json'), JSON.stringify({ type: 'module' }));
    if (malformedCanonical) await writeFile(join(sharedDirectory, 'gatewayConnectionRoutes.js'), 'export const broken = ;\n');
    else await copyFile(canonicalSource, join(sharedDirectory, 'gatewayConnectionRoutes.js'));
  }
  return join(sourceDirectory, 'connection-routes.mjs');
}

test('Relay deploy runtime falls back to the packaged canonical contract only when source layout is absent', async t => {
  const loaderPath = await runtimeTree(t, { canonical: false });
  const contract = await import(pathToFileURL(loaderPath).href);
  const descriptor = {
    version: 1,
    gatewayId: 'a'.repeat(64),
    publicKey: 'b'.repeat(64),
    endpoints: [{ kind: 'public', url: 'https://relay.example/g/a' }],
  };
  assert.deepEqual(contract.parseGatewayConnectionRoutes(descriptor), descriptor);
  assert.deepEqual(contract.parseGatewayConnectionProofQuery(`nonce=${'a'.repeat(48)}&endpoint=${encodeURIComponent('https://relay.example/g/a')}&_=1234567890123456`), {
    nonce: 'a'.repeat(48), endpoint: 'https://relay.example/g/a',
  });
});

test('Relay source loader re-exports the canonical proof query parser', async t => {
  const loaderPath = await runtimeTree(t);
  const contract = await import(pathToFileURL(loaderPath).href);
  assert.deepEqual(contract.parseGatewayConnectionProofQuery(`nonce=${'b'.repeat(48)}&endpoint=${encodeURIComponent('https://relay.example/g/b')}`), {
    nonce: 'b'.repeat(48), endpoint: 'https://relay.example/g/b',
  });
});

test('Relay contract loader does not hide syntax errors in the canonical Studio module', async t => {
  const loaderPath = await runtimeTree(t, { malformedCanonical: true });
  await assert.rejects(import(pathToFileURL(loaderPath).href), SyntaxError);
});
