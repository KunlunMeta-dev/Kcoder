import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRelayLifecycleRemoteCommand } from '../deploy/cli-contract.mjs';

test('a component with a missing output retains unknown identity and the original remote failure', { skip: process.platform !== 'linux' }, t => {
  const namespace = '/tmp/kcoder-relay-cli-test-' + randomBytes(12).toString('hex');
  const stageDir = '/var/tmp/kcoder-relay-deploy-' + randomBytes(12).toString('hex');
  mkdirSync(namespace, { mode: 0o700 }); mkdirSync(join(namespace, 'run'), { mode: 0o700 });
  const bin = join(namespace, 'bin'); mkdirSync(bin, { mode: 0o700 });
  mkdirSync(stageDir, { mode: 0o700 }); mkdirSync(join(stageDir, 'deploy'), { mode: 0o700 });
  t.after(() => { rmSync(namespace, { recursive: true, force: true }); rmSync(stageDir, { recursive: true, force: true }); });
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(stageDir, 'deploy/relay-host.sh'), '#!/bin/sh\n[ "$1" = prepare ] && exit 0\nexit 99\n', { mode: 0o700 });
  writeFileSync(join(stageDir, 'deploy/stun-host.sh'), '#!/bin/sh\nexit 3\n', { mode: 0o700 });
  const command = createRelayLifecycleRemoteCommand({ action: 'install', stageDir, port: 8452, testNamespace: namespace });
  const result = spawnSync('/bin/bash', ['-c', command], { env: { PATH: bin + ':/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 3, result.stderr);
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.component, row.state]), [['stun', 'unknown'], ['relay', 'not-run']]);
});
