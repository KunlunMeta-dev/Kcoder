import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stageGatewayDependencies } from './stage-gateway-dependencies.mjs';

test('stages portable Gateway dependencies without cross-platform native binaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-ssh-packaging-'));
  try {
    await mkdir(join(directory, 'node_modules', 'retired-native-addon'), { recursive: true });
    await writeFile(join(directory, 'node_modules', 'retired-native-addon', 'stale.node'), 'fixture');
    const targetPlatform = process.platform === 'win32' ? 'linux' : 'win32';
    const { output, packages } = await stageGatewayDependencies({
      destination: join(directory, 'node_modules'),
      targetPlatform,
      targetArch: process.arch,
    });
    assert.ok(packages.ssh2);
    assert.ok(packages['jsonc-parser']);
    assert.ok(packages.ws);
    assert.ok(packages.compression);
    assert.ok(!packages['cpu-features']);
    assert.ok(!packages['node-datachannel']);
    const require = createRequire(join(directory, 'entry.cjs'));
    assert.equal(typeof require('ssh2').Client, 'function');
    assert.equal(typeof require('ws').WebSocketServer, 'function');
    assert.equal(typeof require('compression'), 'function');
    assert.deepEqual(require('jsonc-parser').parse('{ /* fixture */ "ok": true }'), { ok: true });
    const files = await readdir(output, { recursive: true });
    assert.ok(!files.some(file => file.endsWith('.node')));
    assert.ok(!files.some(file => file.includes('retired-native-addon')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
