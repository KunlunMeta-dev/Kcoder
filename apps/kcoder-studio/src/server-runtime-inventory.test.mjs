import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeServerInventory } from './server-runtime-inventory.mjs';

function fixture() {
  const target = { id: 'original', transport: 'ssh', security: {}, revision: 'original' };
  const state = { generation: 3, principal: { principalId: 'account-original' }, brokers: [] };
  const broker = () => ({ serverId: target.id, targetId: target.id, closed: false,
    child: { exitCode: null, signalCode: null }, agentMessageTargetSignature: target.revision,
    loginOwner: 'original-owner', agentMessageAccountGeneration: state.generation,
    initializeResponse: { result: { cwd: '/native/original-auto-workspace' } } });
  const inventory = createRuntimeServerInventory({ getServers: () => [target], getBrokers: () => state.brokers,
    publicServer: value => ({ id: value.id }),
    targetSignature: value => value.revision, observationIdentity: value => value, authorityIdFor: () => 'authority',
    loginContexts: { identity: () => state.principal, generation: () => state.generation } });
  return { target, state, broker, inventory, session: { allowedServerIds: new Set([target.id]) } };
}

test('inventory discloses only current allowed account Native cwd hints without spawning or filesystem reads', () => {
  const f = fixture(); f.state.brokers.push(f.broker());
  const response = f.inventory.publicServerInventory(f.session, 'original-owner');
  assert.deepEqual(response.servers[0].workspaceHints, { version: 1, paths: ['/native/original-auto-workspace'] });
  f.session.allowedServerIds.clear();
  assert.deepEqual(f.inventory.publicServerInventory(f.session, 'original-owner').servers, []);
});

test('closed, foreign, uninitialized, changed target and old same-account generations never provide hints', () => {
  for (const change of [
    b => { b.closed = true; }, b => { b.nativeManagementOnly = true; },
    b => { b.serverId = 'other'; }, b => { b.targetId = 'other'; },
    b => { b.loginOwner = 'other-owner'; }, b => { b.agentMessageAccountGeneration = 2; },
    b => { b.agentMessageTargetSignature = 'changed'; }, b => { b.initializeResponse = null; },
    b => { b.child.exitCode = 0; }, b => { b.child.signalCode = 'SIGTERM'; },
    b => { b.initializeResponse.result.cwd = '/native/unsafe\npath'; },
  ]) {
    const f = fixture(), broker = f.broker(); change(broker); f.state.brokers.push(broker);
    assert.equal(f.inventory.publicServerInventory(f.session, 'original-owner').servers[0].workspaceHints, undefined);
  }
  const f = fixture(); f.state.brokers.push(f.broker()); f.state.principal = null;
  assert.equal(f.inventory.publicServerInventory(f.session, 'original-owner').servers[0].workspaceHints, undefined);
});

test('workspace hint reads are bounded and duplicate Native workspaces share one comparison entry', () => {
  const f = fixture(); f.state.brokers = Array.from({ length: 500 }, () => f.broker());
  assert.equal(f.inventory.publicServerInventory(f.session, 'original-owner').servers[0].workspaceHints.paths.length, 1);
  f.state.brokers = Array.from({ length: 500 }, (_, i) => ({ ...f.broker(), initializeResponse: { result: { cwd: `/native/work-${i}` } } }));
  assert.equal(f.inventory.publicServerInventory(f.session, 'original-owner').servers[0].workspaceHints.paths.length, 64);
  assert.equal(f.inventory.publicServerInventory(f.session, 'original-owner').servers[0].workspaceHints.truncated, true);
});

test('a Native cwd hint must be absolute on its real target platform', () => {
  for (const path of ['relative/path', 'D:relative', '\\root-relative']) {
    const f = fixture(); f.target.remotePlatform = 'windows';
    const broker = f.broker(); broker.initializeResponse.result.cwd = path; f.state.brokers.push(broker);
    assert.equal(f.inventory.publicServerInventory(f.session, 'original-owner').servers[0].workspaceHints, undefined);
  }
  const f = fixture(); f.target.remotePlatform = 'windows';
  const broker = f.broker(); broker.initializeResponse.result.cwd = 'D:\\native\\original'; f.state.brokers.push(broker);
  assert.deepEqual(f.inventory.publicServerInventory(f.session, 'original-owner').servers[0].workspaceHints.paths, ['D:\\native\\original']);
});

test('one directory read visits each broker once and the next read observes current lifecycle', () => {
  const targets = Array.from({ length: 80 }, (_, i) => ({ id: `target-${i}`, transport: 'local' }));
  let visits = 0, scans = 0;
  const brokers = targets.map(target => ({ serverId: target.id, targetId: target.id,
    child: { exitCode: null, signalCode: null }, agentMessageTargetSignature: target.id,
    initializeResponse: { result: { cwd: `/native/${target.id}` } } }));
  const inventory = createRuntimeServerInventory({ getServers: () => targets,
    getBrokers: function* () { scans++; for (const broker of brokers) { visits++; yield broker; } },
    publicServer: target => ({ id: target.id }), targetSignature: target => target.id,
    observationIdentity: value => value, loginContexts: {} });
  const session = { allowedServerIds: new Set(targets.map(target => target.id)) };
  const first = inventory.publicServerInventory(session);
  assert.equal(scans, 1); assert.equal(visits, brokers.length);
  assert.deepEqual(first.servers.map(server => server.workspaceHints.paths), targets.map(target => [`/native/${target.id}`]));
  brokers[0].child.exitCode = 0;
  session.allowedServerIds.delete(targets[1].id);
  const next = inventory.publicServerInventory(session);
  assert.equal(scans, 2); assert.equal(visits, brokers.length * 2);
  assert.equal(next.servers[0].workspaceHints, undefined);
  assert.equal(next.servers.some(server => server.id === targets[1].id), false);
  assert.deepEqual(first.servers[0].workspaceHints.paths, ['/native/target-0']);
  session.allowedServerIds.clear();
  assert.deepEqual(inventory.publicServerInventory(session), { servers: [] });
  assert.equal(scans, 2, 'an empty authorized directory does not scan brokers');
});

test('the shared broker traversal retains the global observation limit and private account boundary', () => {
  const f = fixture();
  let visits = 0;
  const brokers = Array.from({ length: 1030 }, () => f.broker());
  const other = { ...f.target, id: 'other' };
  const inventory = createRuntimeServerInventory({ getServers: () => [f.target, other],
    getBrokers: function* () { for (const broker of brokers) { visits++; yield broker; } },
    publicServer: target => ({ id: target.id }), targetSignature: target => target.revision,
    observationIdentity: value => value, authorityIdFor: () => 'authority',
    loginContexts: { identity: (_, id) => id === other.id ? null : f.state.principal,
      generation: () => f.state.generation } });
  f.session.allowedServerIds.add(other.id);
  const result = inventory.publicServerInventory(f.session, 'original-owner');
  assert.equal(visits, 1025);
  assert.equal(result.servers[0].workspaceHints.paths.length, 1);
  assert.equal(result.servers[0].workspaceHints.truncated, true);
  assert.equal(result.servers[1].workspaceHints, undefined);
  f.state.principal = null;
  assert.equal(inventory.publicServerInventory(f.session, 'original-owner').servers[0].workspaceHints, undefined);
});

test('a full target stops early and missing login identity never starts a broker scan', () => {
  const f = fixture();
  let visits = 0;
  const inventory = createRuntimeServerInventory({ getServers: () => [f.target],
    getBrokers: function* () {
      for (let i = 0; i < 2000; i++) {
        visits++;
        yield { ...f.broker(), initializeResponse: { result: { cwd: `/native/${i}` } } };
      }
    }, publicServer: target => ({ id: target.id }), targetSignature: target => target.revision,
    observationIdentity: value => value, authorityIdFor: () => 'authority',
    loginContexts: { identity: () => f.state.principal, generation: () => {
      assert.ok(f.state.principal, 'missing identity must not consult account generation');
      return f.state.generation;
    } } });
  const result = inventory.publicServerInventory(f.session, 'original-owner');
  assert.equal(visits, 65); assert.equal(result.servers[0].workspaceHints.truncated, true);
  for (const owner of [undefined, 'original-owner']) {
    f.state.principal = null;
    assert.equal(inventory.publicServerInventory(f.session, owner).servers[0].workspaceHints, undefined);
  }
  assert.equal(visits, 65);
});

test('local MCP preset facts are attached per target only when the Gateway provides them', () => {
  const targets = [{ id: 'local', transport: 'local' }, { id: 'remote', transport: 'ssh' }];
  const presets = { version: 1, playwright: { command: 'playwright-mcp', defaultBrowser: 'chrome', outputDirectory: '/private/out' } };
  const inventory = createRuntimeServerInventory({ getServers: () => targets, getBrokers: () => [],
    publicServer: value => ({ id: value.id }), targetSignature: value => value.id, observationIdentity: value => value,
    authorityIdFor: () => 'authority', loginContexts: { identity: () => null, generation: () => 0 },
    localMcpPresets: target => (target.transport === 'local' ? presets : undefined) });
  const [local, remote] = inventory.publicServerInventory({ allowedServerIds: new Set(['local', 'remote']) }, null).servers;
  assert.deepEqual(local.localMcpPresets, presets);
  assert.equal('localMcpPresets' in remote, false);
});
