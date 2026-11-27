import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceOpenController, parseWorkspaceOpenRequest } from './workspace-open-controller.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-workspace-open-'));
  const handlers = new Map(), events = [];
  const contents = { mainFrame: { url: 'http://127.0.0.1:3210/' }, getURL: () => contents.mainFrame.url, send: (...args) => events.push(args) };
  const window = { webContents: contents, isDestroyed: () => false };
  let servers = [{ id: 'remote-selected', transport: 'ssh' }, { id: 'native-target', transport: 'local', command: '/bin/kcoder' }];
  const controller = createWorkspaceOpenController({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getWindow: () => window, getGatewayOrigin: () => 'http://127.0.0.1:3210', getServers: async () => typeof servers === 'function' ? servers() : servers });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  t.after(async () => { controller.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, controller, contents, window, handlers, events, event,
    take: () => handlers.get('kcoder:workspace-open:pending')(event), ack: id => handlers.get('kcoder:workspace-open:ack')(event, id),
    setServers: value => { servers = value; } };
}

test('CLI parsing preserves spaces, resolves relative paths against the invoking process, and rejects malformed flags', () => {
  const request = parseWorkspaceOpenRequest(['kcoder-studio', '--open-workspace', 'my project', '--workspace-label', 'Project A'], tmpdir());
  assert.equal(request.path, join(tmpdir(), 'my project')); assert.equal(request.label, 'Project A');
  assert.equal(parseWorkspaceOpenRequest(['kcoder-studio'], tmpdir()), null);
  assert.throws(() => parseWorkspaceOpenRequest(['kcoder-studio', '--open-workspace'], tmpdir()), /Invalid/);
});

test('full and remote packages carry recovery, and only the full host carries local workspace intents', async () => {
  const full = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const remote = JSON.parse(await readFile(new URL('../electron-builder.remote.json', import.meta.url), 'utf8'));
  for (const files of [full.build.files, remote.files]) assert.ok(files.includes('desktop/window-responsiveness.mjs'));
  assert.ok(full.build.files.includes('desktop/workspace-open-controller.mjs'));
  assert.equal(remote.files.includes('desktop/workspace-open-controller.mjs'), false);
});

test('pending startup and second-instance requests use the verified local target and remain until acknowledged', async t => {
  const f = await fixture(t);
  const request = parseWorkspaceOpenRequest(['kcoder-studio', '--open-workspace', f.root], tmpdir());
  f.controller.enqueue(request);
  const first = await f.take(); assert.equal(first[0].serverId, 'native-target'); assert.equal(first[0].path, f.root);
  assert.equal((await f.take())[0].id, first[0].id);
  f.ack(first[0].id); assert.deepEqual(await f.take(), []);
  f.controller.enqueue({ ...request, id: 'second' }); assert.equal((await f.take())[0].id, 'second');
});

test('foreign senders and frames cannot read or acknowledge CLI intents', async t => {
  const f = await fixture(t); f.controller.enqueue({ id: 'owned', path: f.root });
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.contents.mainFrame.url } }]) {
    await assert.rejects(f.handlers.get('kcoder:workspace-open:pending')(event), /restricted/);
    assert.throws(() => f.handlers.get('kcoder:workspace-open:ack')(event, 'owned'), /restricted/);
  }
});

test('ambiguous or edited local targets fail explicitly instead of selecting another identity', async t => {
  const f = await fixture(t); f.controller.enqueue({ id: 'ambiguous', path: f.root });
  f.setServers([{ id: 'a', transport: 'local' }, { id: 'b', transport: 'local' }]);
  assert.match((await f.take())[0].error, /specify --workspace-server/); f.ack('ambiguous');
  f.controller.enqueue({ id: 'explicit', serverId: 'b', path: f.root });
  assert.equal((await f.take())[0].serverId, 'b');
  f.setServers([{ id: 'b', transport: 'local', profile: 'different-user' }]);
  assert.match((await f.take())[0].error, /target changed/);
});

test('an invalid directory does not block a later valid request', async t => {
  const f = await fixture(t);
  f.controller.enqueue({ id: 'missing', path: join(f.root, 'missing') }); f.controller.enqueue({ id: 'valid', path: f.root });
  const requests = await f.take(); assert.match(requests[0].error, /directory/); assert.equal(requests[1].serverId, 'native-target');
});

test('navigation during target verification cannot deliver local paths', async t => {
  const f = await fixture(t); let release;
  f.controller.enqueue({ id: 'held', path: f.root });
  f.setServers(() => new Promise(resolve => { release = resolve; }));
  const take = f.take(); f.contents.mainFrame = { url: 'https://foreign.example/' };
  release([{ id: 'local', transport: 'local' }]);
  await assert.rejects(take, /restricted/);
});
