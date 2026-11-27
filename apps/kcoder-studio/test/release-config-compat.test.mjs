import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createSshConnectionStore } from '../src/ssh-terminal-store.js';
import { loadResourcePolicy } from '../src/resource-policy.js';

const fixture = name => readFile(new URL(`../../kcoder-channel-host/test/fixtures/settings/${name}`, import.meta.url));

test('release v1 SSH profiles and resource budgets remain usable without version or byte rewrites', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-release-config-compat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ssh = join(directory, 'ssh_connections.jsonc'), policy = join(directory, 'resource_policy.jsonc');
  const sshBytes = await fixture('ssh-release-v1.jsonc'), policyBytes = await fixture('resource-policy-release-v1.jsonc');
  await writeFile(ssh, sshBytes, { mode: 0o600 }); await writeFile(policy, policyBytes, { mode: 0o600 });
  const store = createSshConnectionStore({ filePath: ssh });
  assert.deepEqual(await store.list(), [{ id: 'release-connection', label: 'Release fixture', host: 'localhost', port: 2222, username: 'fixture', authMethod: 'agent' }]);
  const effective = await loadResourcePolicy(policy, { required: true });
  assert.equal(effective.maxProcesses, 3); assert.equal(effective.maxResidentBytes, 104857600);
  assert.equal(effective.sweepIntervalMs, 10000); assert.equal(effective.sampleLimit, 8);
  assert.deepEqual(await readFile(ssh), sshBytes); assert.deepEqual(await readFile(policy), policyBytes);
  assert.deepEqual((await readdir(directory)).sort(), ['resource_policy.jsonc', 'ssh_connections.jsonc']);
});
