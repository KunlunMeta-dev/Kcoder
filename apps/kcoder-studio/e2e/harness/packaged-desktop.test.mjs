import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { startPackagedDesktop } from './packaged-desktop.mjs';

function fixture({ failReady = false } = {}) {
  const calls = [], cleanup = [];
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  const page = {
    url: () => 'http://127.0.0.1:32111/',
    getByTestId: id => ({ async waitFor() {
      calls.push(['ready', id]);
      if (failReady) throw new Error('fixture startup failure');
    } }),
  };
  const context = {
    pathInState: name => `/owned-run/state/${name}`,
    isolatedEnvironment: overrides => overrides,
    spawnOwned(label, executable, args, options) {
      calls.push(['spawn', label, executable, args, options]);
      queueMicrotask(() => child.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:32112/devtools/browser/fixture\n'));
      return child;
    },
    registerPort: (label, port) => calls.push(['port', label, port]),
    addCleanup: (label, action) => cleanup.push([label, action]),
    stopOwned: async label => { calls.push(['stop', label]); },
  };
  const dependencies = {
    executable: async path => path,
    connect: async endpoint => {
      calls.push(['connect', endpoint]);
      return { contexts: () => [{ pages: () => [page] }], close: async () => { calls.push(['disconnect']); } };
    },
  };
  return { context, dependencies, calls, cleanup };
}

test('packaged host isolates both profiles and cleans only its owned process', async () => {
  const value = fixture();
  const desktop = await startPackagedDesktop(value.context, {
    root: '/fixture-package', label: 'wiki-round-0', servers: '/owned-run/state/servers.json',
    workspace: '/owned-run/workspace',
  }, value.dependencies);
  const spawn = value.calls.find(call => call[0] === 'spawn');
  assert.equal(spawn[4].env.KCODER_CONFIG_DIR, '/owned-run/state/home');
  assert.equal(spawn[4].env.KCODER_STUDIO_DESKTOP_USER_DATA_DIR, '/owned-run/state/desktop-profile');
  assert.ok(spawn[3].includes('--remote-debugging-port=0'));
  assert.deepEqual(value.calls.find(call => call[0] === 'port'), ['port', 'wiki-round-0', 32112]);
  await desktop.stop();
  await desktop.stop();
  for (const [, cleanup] of value.cleanup) await cleanup();
  assert.deepEqual(value.calls.filter(call => call[0] === 'stop'), [['stop', 'wiki-round-0']]);
  assert.equal(value.calls.filter(call => call[0] === 'disconnect').length, 1);
});

test('startup failure still registers the CDP cleanup before readiness', async () => {
  const value = fixture({ failReady: true });
  await assert.rejects(startPackagedDesktop(value.context, {
    root: '/fixture-package', label: 'wiki-failure', servers: '/owned-run/state/servers.json',
    workspace: '/owned-run/workspace',
  }, value.dependencies), /fixture startup failure/);
  assert.equal(value.cleanup.length, 1);
  await value.cleanup[0][1]();
  assert.equal(value.calls.filter(call => call[0] === 'disconnect').length, 1);
});
