import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResourcePolicy, loadResourcePolicy } from '../src/resource-policy.js';
import { mkdtemp, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('resource policy defaults are disabled and JSONC enables explicit budgets', () => {
  assert.equal(parseResourcePolicy('{}').enabled, false);
  const policy = parseResourcePolicy('{/* explicit */"resources":{"idle_budget":{"max_processes":0,}},}');
  assert.equal(policy.enabled, true);
  assert.equal(policy.maxProcesses, 0);
  assert.equal(policy.maxResidentBytes, null);
  for (const text of ['[]', '{"other":1}', '{"resources":{"idle_budget":{"max_processes":-1}}}',
    '{"meta":{"config_version":2}}', '{"resources":{"idle_budget":{"sample_limit":33}}}'])
    assert.throws(() => parseResourcePolicy(text));
});

test('documented default policy loads without enabling limits', async () => {
  const policy = await loadResourcePolicy(new URL('../config/resource_policy.jsonc', import.meta.url), { required: true });
  assert.deepEqual(policy, parseResourcePolicy('{}'));
  assert.throws(() => parseResourcePolicy('{"resources":null}'));
  assert.throws(() => parseResourcePolicy('{"meta":{"config_version":null}}'));
});

test('resource policy reads are bounded and explicit missing files do not silently disable budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-resource-policy-'));
  try {
    const path = join(root, 'resource_policy.jsonc');
    assert.equal((await loadResourcePolicy(path)).enabled, false);
    await assert.rejects(loadResourcePolicy(path, { required: true }));
    await writeFile(path, '{}');
    assert.equal((await loadResourcePolicy(path)).enabled, false);
    assert.equal((await loadResourcePolicy(path, { noFollow: 0 })).enabled, false);
    await writeFile(path, ' '.repeat(65_537));
    await assert.rejects(loadResourcePolicy(path), /64 KiB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('platform fallback rejects links, linked directories, invalid UTF-8 and oversized policies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-resource-policy-fallback-'));
  try {
    const path = join(root, 'policy.json');
    await writeFile(path, '{"resources":{"idle_budget":{"max_processes":7}}}');
    assert.equal((await loadResourcePolicy(path, { required: true, noFollow: 0 })).maxProcesses, 7);
    await assert.rejects(loadResourcePolicy(root, { noFollow: 0 }), /regular file/);
    const directory = join(root, 'nested');
    await mkdir(directory);
    await writeFile(join(directory, 'policy.json'), '{}');
    const linkedDirectory = join(root, 'linked');
    await symlink(directory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(loadResourcePolicy(join(linkedDirectory, 'policy.json'), { noFollow: 0 }), /without links/);
    if (process.platform !== 'win32') {
      const link = join(root, 'link.json');
      await symlink(path, link);
      await assert.rejects(loadResourcePolicy(link, { noFollow: 0 }), /without links/);
    }
    await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(loadResourcePolicy(path, { noFollow: 0 }));
    await writeFile(path, ' '.repeat(65_537));
    await assert.rejects(loadResourcePolicy(path, { noFollow: 0 }), /64 KiB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
