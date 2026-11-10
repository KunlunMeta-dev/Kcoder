import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readMigrationRendererBaseline } from './migration-renderer-baseline.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-renderer-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = 'apps/kcoder-studio/renderer/src/main.ts', dist = join(root, 'renderer-dist');
  await mkdir(join(root, 'renderer-inputs/apps/kcoder-studio/renderer/src'), { recursive: true }); await mkdir(dist);
  await writeFile(join(root, 'renderer-inputs', input), 'source'); await writeFile(join(dist, 'index.html'), 'output');
  const inputs = [{ path: input, sha256: sha('source') }], outputs = [{ path: 'index.html', sha256: sha('output'), bytes: 6 }];
  for (const name of ['renderer-before.json', 'renderer-after.json']) await writeFile(join(root, name), JSON.stringify(inputs));
  await writeFile(join(root, 'renderer-output-files.json'), JSON.stringify(outputs));
  const proof = { inputCount: 1, outputCount: 1, sourceSha256: sha(JSON.stringify(inputs)), outputsSha256: sha(JSON.stringify(outputs)),
    dist, drift: [], inputs: 'renderer-before.json', outputs: 'renderer-output-files.json', command: 'pnpm --dir apps/kcoder-studio/renderer build', exitCode: 0 };
  const proofFile = join(root, 'renderer-source-check.json'); await writeFile(proofFile, JSON.stringify(proof));
  return { root, dist, proof, proofFile, options: { proofFile, proofSha256: sha(await readFile(proofFile)), rendererRoot: dist } };
}

test('retained build admission verifies source and output inventories and identifies its older source honestly', async t => {
  const value = await fixture(t), admitted = await readMigrationRendererBaseline(value.options);
  assert.equal(admitted.currentMainSourceFreshnessClaim, false); assert.equal(admitted.inputCount, 1);
  await assert.rejects(readMigrationRendererBaseline({ ...value.options, proofSha256: '0'.repeat(64) }), /proof changed/);
  await writeFile(join(value.dist, 'index.html'), 'changed'); await assert.rejects(readMigrationRendererBaseline(value.options), /bytes changed/);
});

test('unlisted output and changed retained source fail before a browser or workload starts', async t => {
  const value = await fixture(t);
  await writeFile(join(value.dist, 'extra.js'), 'unlisted'); await assert.rejects(readMigrationRendererBaseline(value.options), /inventory changed/);
  await rm(join(value.dist, 'extra.js'));
  await writeFile(join(value.root, 'renderer-inputs/apps/kcoder-studio/renderer/src/main.ts'), 'changed');
  await assert.rejects(readMigrationRendererBaseline(value.options), /bytes changed/);
});

test('new source receipts may omit fixed inventory leaf labels but cannot redirect them', async t => {
  const value = await fixture(t); delete value.proof.inputs; delete value.proof.outputs;
  await writeFile(value.proofFile, JSON.stringify(value.proof)); value.options.proofSha256 = sha(await readFile(value.proofFile));
  assert.equal((await readMigrationRendererBaseline(value.options)).inputCount, 1);
  value.proof.inputs = '../foreign.json'; await writeFile(value.proofFile, JSON.stringify(value.proof));
  value.options.proofSha256 = sha(await readFile(value.proofFile)); await assert.rejects(readMigrationRendererBaseline(value.options));
});

test('a hash-only output inventory still measures every exact byte for the workload copy receipt', async t => {
  const value = await fixture(t), output = [{ path: 'index.html', sha256: sha('output') }];
  await writeFile(join(value.root, 'renderer-output-files.json'), JSON.stringify(output));
  value.proof.outputsSha256 = sha(JSON.stringify(output)); await writeFile(value.proofFile, JSON.stringify(value.proof));
  value.options.proofSha256 = sha(await readFile(value.proofFile));
  const observed = await readMigrationRendererBaseline(value.options);
  assert.equal(observed.copyManifestSha256, sha(JSON.stringify([{ path: 'index.html', bytes: 6, sha256: sha('output') }])));
  await writeFile(join(value.dist, 'index.html'), 'tampered'); await assert.rejects(readMigrationRendererBaseline(value.options), /bytes changed/);
});
