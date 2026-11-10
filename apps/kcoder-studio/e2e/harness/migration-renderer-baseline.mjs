import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');

/** Admit a previously built, fully retained baseline without claiming current-source freshness. */
export async function readMigrationRendererBaseline({ proofFile, proofSha256, rendererRoot }) {
  assert.ok(isAbsolute(proofFile) && isAbsolute(rendererRoot));
  assert.match(proofSha256, /^[a-f0-9]{64}$/);
  const ordinary = async file => {
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 64 * 1024 * 1024, 'baseline requires bounded ordinary files');
    assert.equal(await realpath(file), file, 'baseline cannot traverse linked ancestors');
    return readFile(file);
  };
  const proofBytes = await ordinary(proofFile); assert.equal(sha(proofBytes), proofSha256, 'renderer build proof changed');
  const proof = JSON.parse(proofBytes), parent = dirname(proofFile);
  assert.equal(proof.command, 'pnpm --dir apps/kcoder-studio/renderer build'); assert.equal(proof.exitCode, 0);
  assert.deepEqual(proof.drift, []); assert.equal(proof.dist, rendererRoot);
  assert.equal(proof.inputs ?? 'renderer-before.json', 'renderer-before.json'); assert.equal(proof.outputs ?? 'renderer-output-files.json', 'renderer-output-files.json');
  const inputs = JSON.parse(await ordinary(resolve(parent, 'renderer-before.json')));
  const after = JSON.parse(await ordinary(resolve(parent, 'renderer-after.json')));
  const outputs = JSON.parse(await ordinary(resolve(parent, 'renderer-output-files.json')));
  assert.deepEqual(after, inputs, 'renderer source changed during the recorded build');
  assert.equal(inputs.length, proof.inputCount); assert.equal(outputs.length, proof.outputCount);
  assert.ok(inputs.length > 0 && inputs.length <= 20000 && outputs.length > 0 && outputs.length <= 20000);
  assert.equal(sha(JSON.stringify(inputs)), proof.sourceSha256); assert.equal(sha(JSON.stringify(outputs)), proof.outputsSha256);
  const verify = async (root, entries, input) => {
    assert.equal(await realpath(root), root);
    const listed = new Set(), observed = []; let bytes = 0;
    for (const entry of entries) {
      assert.ok(typeof entry.path === 'string' && entry.path.split('/').every(part => part && part !== '.' && part !== '..') && !/[\\:\x00-\x1f]/.test(entry.path));
      if (input) assert.match(entry.path, /^apps\/kcoder-studio\/(?:renderer|shared)\//);
      assert.equal(listed.has(entry.path), false); listed.add(entry.path); assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      const data = await ordinary(resolve(root, entry.path)); bytes += data.length;
      assert.ok(bytes <= 512 * 1024 * 1024, 'renderer baseline exceeds bounded admission');
      assert.equal(sha(data), entry.sha256, 'renderer baseline bytes changed');
      if (!input && entry.bytes !== undefined) assert.equal(data.length, entry.bytes);
      observed.push({ path: entry.path, bytes: data.length, sha256: entry.sha256 });
    }
    const found = [];
    const walk = async (path = '', depth = 0) => {
      assert.ok(depth <= 24);
      for (const child of await readdir(resolve(root, path), { withFileTypes: true })) {
        const relative = path ? `${path}/${child.name}` : child.name;
        assert.equal(child.isSymbolicLink(), false);
        if (child.isDirectory()) await walk(relative, depth + 1);
        else { assert.ok(child.isFile()); found.push(relative); }
      }
    };
    await walk(); assert.deepEqual(found.sort(), [...listed].sort(), 'renderer baseline inventory changed'); return observed;
  };
  await verify(resolve(parent, 'renderer-inputs'), inputs, true); const measuredOutputs = await verify(rendererRoot, outputs, false);
  return { kind: 'retained-source-baseline', proofSha256, sourceSha256: proof.sourceSha256,
    outputsSha256: proof.outputsSha256, inputCount: inputs.length, outputCount: outputs.length,
    copyManifestSha256: sha(JSON.stringify(measuredOutputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
    currentMainSourceFreshnessClaim: false };
}
