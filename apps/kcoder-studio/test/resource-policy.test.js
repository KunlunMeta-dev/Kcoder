import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResourcePolicy, loadResourcePolicy } from '../src/resource-policy.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
    await assert.rejects(loadResourcePolicy(path, { noFollow: 0 }), /unsupported/);
    await writeFile(path, ' '.repeat(65_537));
    await assert.rejects(loadResourcePolicy(path), /64 KiB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
