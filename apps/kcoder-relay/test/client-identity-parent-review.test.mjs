import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { defaultIdentityFile, resolveIdentityFile, prepareClientIdentity, saveRegisteredClientIdentity,
  assertClientIdentityActive, revokeClientIdentity, readClientIdentitySnapshot, readClientIdentityState,
  readRegisteredClientIdentity, prepareInstanceIdentityFile } from '../src/client-identity.mjs';
import { startRegisteredClient } from '../src/client.mjs';
import { createHash } from 'node:crypto';

test('relative XDG defaults never resolve identity storage under the working directory', () => {
  const options = { platform: 'linux', home: '/owned-home', env: { XDG_STATE_HOME: 'target/owned-state' } };
  assert.equal(defaultIdentityFile(options), '/owned-home/.local/state/kcoder-relay/client-identity.json');
  assert.equal(defaultIdentityFile({ ...options, env: { XDG_STATE_HOME: '/owned-state' } }),
    '/owned-state/kcoder-relay/client-identity.json');
});

test('Windows default bases must be fully qualified and retain their configured drive or UNC root', () => {
  const options = { platform: 'win32', home: 'C:\\Users\\owned' };
  for (const base of ['target\\owned-state', 'C:drive-relative', '\\root-relative']) {
    assert.equal(defaultIdentityFile({ ...options, env: { LOCALAPPDATA: base } }),
      'C:\\Users\\owned\\AppData\\Local\\kcoder-relay\\client-identity.json');
  }
  assert.equal(defaultIdentityFile({ ...options, env: { LOCALAPPDATA: 'D:\\OwnedState' } }),
    'D:\\OwnedState\\kcoder-relay\\client-identity.json');
  assert.equal(defaultIdentityFile({ ...options, env: { LOCALAPPDATA: 'relative', APPDATA: '\\\\owned-host\\owned-share\\State' } }),
    '\\\\owned-host\\owned-share\\State\\kcoder-relay\\client-identity.json');
});

test('macOS defaults and explicitly configured relative identity files keep their existing contracts', () => {
  assert.equal(defaultIdentityFile({ platform: 'darwin', home: '/owned-home', env: { XDG_STATE_HOME: 'relative' } }),
    '/owned-home/Library/Application Support/kcoder-relay/client-identity.json');
  assert.equal(resolveIdentityFile({ KCODER_RELAY_IDENTITY_FILE: 'owned-relative/identity.json' }),
    resolve('owned-relative/identity.json'));
});

async function ownedIdentity(t, relayUrl = 'https://relay.example.test') {
  const root = await fs.mkdtemp(join(tmpdir(), 'relay-identity-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { identityFile: join(root, 'private/identity.json'), relayUrl,
    gatewaySecret: 'owned-internal-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
  const pending = await prepareClientIdentity(options);
  const assignment = { id: 'owned-gateway', secret: 'owned-control-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
  await saveRegisteredClientIdentity({ ...options, ...pending, ...assignment });
  return { options, assignment };
}
function markerBarrier(t, path, failure) {
  const open = fs.open;
  let release, entered, completed, armed = false, used = false;
  const blocked = new Promise(resolve => { entered = resolve; });
  const finished = new Promise(resolve => { completed = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    if (armed && !used && args[0] === path) {
      used = true; entered(); await hold; completed(); if (failure) throw failure;
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { release(); mocked.mock.restore(); syncBuiltinESMExports(); });
  return { arm: () => { armed = true; }, blocked, finished, release };
}

test('an active-authority read cannot return allow after revoke completes during its awaited marker validation', { timeout: 5000 }, async t => {
  const { options, assignment } = await ownedIdentity(t), barrier = markerBarrier(t, options.identityFile);
  barrier.arm(); const reading = assertClientIdentityActive({ ...options, ...assignment });
  await barrier.blocked; await revokeClientIdentity(options); barrier.release();
  await assert.rejects(reading, { code: 'RELAY_IDENTITY_REVOKED' });
});

test('a live control open cannot create a data connection after revoke wins its awaited identity check', { timeout: 5000 }, async t => {
  const server = createServer(), peers = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const peer of peers.clients) peer.terminate();
    await new Promise(resolve => peers.close(resolve));
    await new Promise(resolve => server.close(resolve)); server.closeAllConnections?.();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const { options } = await ownedIdentity(t, url), barrier = markerBarrier(t, options.identityFile);
  let settle;
  const outcome = new Promise(resolve => { settle = resolve; });
  const connected = once(peers, 'connection');
  const client = await startRegisteredClient({ ...options, url, gateway: url, allowInsecure: true,
    onDiagnostic: record => { if (['control_error', 'data_connecting'].includes(record.event)) settle(record.event); } });
  t.after(() => client.close());
  const [control] = await connected; barrier.arm();
  control.send(JSON.stringify({ type: 'open', id: 'a'.repeat(48) }));
  await barrier.blocked; await revokeClientIdentity(options); barrier.release();
  assert.equal(await outcome, 'control_error', 'revoked authority must reject before a data handshake is attempted');
});

test('install snapshots also reject a deny committed during awaited pointer validation', { timeout: 5000 }, async t => {
  const { options } = await ownedIdentity(t), barrier = markerBarrier(t, options.identityFile);
  barrier.arm(); const reading = readClientIdentitySnapshot(options);
  await barrier.blocked; await revokeClientIdentity(options); barrier.release();
  await assert.rejects(reading, { code: 'RELAY_IDENTITY_REVOKED' });
});

test('a valid replacement reference cannot switch an active read to a different epoch', { timeout: 5000 }, async t => {
  const first = await ownedIdentity(t), peer = await ownedIdentity(t), barrier = markerBarrier(t, first.options.identityFile);
  barrier.arm(); const reading = assertClientIdentityActive({ ...first.options, ...first.assignment });
  await barrier.blocked;
  await fs.rename(first.options.identityFile + '.state-v2', first.options.identityFile + '.retained-state');
  await fs.rename(peer.options.identityFile + '.state-v2', first.options.identityFile + '.state-v2');
  barrier.release();
  await assert.rejects(reading, { code: 'RELAY_IDENTITY_RECOVERY_REQUIRED' });
});

test('a legacy read cannot ignore a committed deny whose marker publication lost its receipt', { timeout: 5000 }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'relay-legacy-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { identityFile: join(root, 'legacy.json'), relayUrl: 'https://relay.example.test',
    gatewaySecret: 'owned-internal-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
  const assignment = { id: 'owned-legacy', secret: 'owned-control-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
  const bytes = JSON.stringify({ version: 1, relayOrigin: options.relayUrl,
    gatewaySecretHash: createHash('sha256').update(options.gatewaySecret).digest('hex'), ...assignment });
  await fs.writeFile(options.identityFile, bytes, { mode: 0o600 });
  const barrier = markerBarrier(t, options.identityFile), link = fs.link;
  const mocked = t.mock.method(fs, 'link', async (...args) => {
    if (String(args[0]).endsWith('marker.json')) throw Object.assign(new Error('CONTROLLED_MARKER_IO_FAILURE'), { code: 'EIO' });
    return link(...args);
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  barrier.arm(); const reading = assertClientIdentityActive({ ...options, ...assignment });
  const denied = assert.rejects(reading, { code: 'RELAY_IDENTITY_REVOKED' });
  await barrier.blocked;
  try {
    await assert.rejects(revokeClientIdentity(options), error => {
      assert.equal(error.code, 'RELAY_IDENTITY_COMMIT_UNCONFIRMED'); assert.equal(error.externalOutcome, 'unknown');
      assert.equal(error.cause.code, 'EIO'); assert.equal(Object.keys(error).includes('cause'), false); return true;
    });
    assert.equal(await fs.readFile(options.identityFile, 'utf8'), bytes);
  } finally { barrier.release(); await denied; }
  assert.equal((await readClientIdentityState(options)).status, 'revoked');
  mocked.mock.restore(); syncBuiltinESMExports();
  const reference = await fs.readFile(options.identityFile + '.state-v2/reference.json', 'utf8');
  await revokeClientIdentity(options);
  assert.equal(await fs.readFile(options.identityFile + '.state-v2/reference.json', 'utf8'), reference);
});

test('active authority reads have an independent bounded I/O budget and never cache a revoked allow', async t => {
  const { options, assignment } = await ownedIdentity(t);
  const counts = { opens: 0, scans: 0, writes: 0 }, open = fs.open, readdir = fs.readdir;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    counts.opens++; if (typeof args[1] === 'string' && args[1].includes('w')) counts.writes++;
    return open(...args);
  });
  const scan = t.mock.method(fs, 'readdir', async (...args) => { counts.scans++; return readdir(...args); });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); scan.mock.restore(); syncBuiltinESMExports(); });
  for (let n = 0; n < 10; n++) await assertClientIdentityActive({ ...options, ...assignment });
  t.diagnostic(JSON.stringify({ activeObservations: 10, ...counts }));
  const maximumOpens=process.platform==='win32'?160:80;
  assert.ok(counts.opens > 0 && counts.opens <= maximumOpens, JSON.stringify(counts));
  assert.equal(counts.scans, 0); assert.equal(counts.writes, 0);
  mocked.mock.restore(); scan.mock.restore(); syncBuiltinESMExports();
  await revokeClientIdentity(options);
  await assert.rejects(readRegisteredClientIdentity(options), { code: 'RELAY_IDENTITY_REVOKED' });
});

test('alias revocation and a late assignment use the original shared epoch', async t => {
  const { options, assignment } = await ownedIdentity(t), alias = join(resolve(options.identityFile, '..'), 'alias.json');
  await prepareInstanceIdentityFile({ ...options, identityFile: alias, legacyIdentityFile: options.identityFile });
  const original = JSON.parse(await fs.readFile(options.identityFile + '.state-v2/reference.json'));
  const moved = JSON.parse(await fs.readFile(alias + '.state-v2/reference.json'));
  assert.equal(moved.epoch, original.epoch); assert.equal(moved.generation, original.generation);
  await revokeClientIdentity({ identityFile: alias });
  await assert.rejects(assertClientIdentityActive({ ...options, ...assignment }), { code: 'RELAY_IDENTITY_REVOKED' });
  await assert.rejects(saveRegisteredClientIdentity({ ...options, enrollmentToken: 'owned-old-proof-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ...assignment }), { code: 'RELAY_IDENTITY_REVOKED' });
});

test('an open from a closed control generation cannot create data while reconnect is pending', { timeout: 5000 }, async t => {
  const server = createServer(), peers = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const peer of peers.clients) peer.terminate();
    await new Promise(resolve => peers.close(resolve));
    await new Promise(resolve => server.close(resolve)); server.closeAllConnections?.();
  });
  const url = `http://127.0.0.1:${server.address().port}`, { options } = await ownedIdentity(t, url);
  const reference = JSON.parse(await fs.readFile(options.identityFile + '.state-v2/reference.json'));
  const barrier = markerBarrier(t, options.identityFile), lstat = fs.lstat;
  let releasePhase = false, checked, closed;
  const finished = new Promise(resolve => { checked = resolve; });
  const controlClosed = new Promise(resolve => { closed = resolve; });
  const mocked = t.mock.method(fs, 'lstat', async (...args) => {
    try { return await lstat(...args); }
    finally { if (releasePhase && args[0] === join(reference.epoch, 'next/next')) checked(); }
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const attempts = [], connected = once(peers, 'connection');
  const client = await startRegisteredClient({ ...options, url, gateway: url, allowInsecure: true, retryMs: 10000,
    onDiagnostic: record => {
      if (record.event === 'control_close') closed();
      if (record.event === 'data_connecting') attempts.push(record.generation);
    } });
  t.after(() => client.close());
  const [control] = await connected; barrier.arm(); control.send(JSON.stringify({ type: 'open', id: 'b'.repeat(48) }));
  await barrier.blocked; control.close(); await controlClosed;
  releasePhase = true; barrier.release(); await finished; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(attempts, [], 'the closed control must lose ownership before its reconnect timer fires');
});

test('a late identity failure from an old control does not stop its already connected replacement', { timeout: 5000 }, async t => {
  const server = createServer(), peers = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const peer of peers.clients) peer.terminate();
    await new Promise(resolve => peers.close(resolve));
    await new Promise(resolve => server.close(resolve)); server.closeAllConnections?.();
  });
  const url = `http://127.0.0.1:${server.address().port}`, { options } = await ownedIdentity(t, url);
  const barrier = markerBarrier(t, options.identityFile, Object.assign(new Error('CONTROLLED_OLD_READ_FAILURE'), { code: 'EIO' }));
  const errors = []; let replacementOnline;
  const online = new Promise(resolve => { replacementOnline = resolve; });
  const connected = once(peers, 'connection');
  const client = await startRegisteredClient({ ...options, url, gateway: url, allowInsecure: true, retryMs: 0,
    onDiagnostic: record => {
      if (record.event === 'control_error') errors.push(record.generation);
      if (record.event === 'control_open' && record.generation > 1) replacementOnline();
    } });
  t.after(() => client.close());
  const [control] = await connected; barrier.arm(); control.send(JSON.stringify({ type: 'open', id: 'c'.repeat(48) }));
  await barrier.blocked; const replacement = once(peers, 'connection'); control.close();
  const [current] = await replacement; await online;
  barrier.release(); await barrier.finished; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []); assert.equal(current.readyState, 1);
  client.close();
});

test('an assignment whose decision committed but reload failed is unknown and reconciles the original assignment', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'relay-assignment-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { identityFile: join(root, 'identity.json'), relayUrl: 'https://relay.example.test',
    gatewaySecret: 'owned-internal-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
  const pending = await prepareClientIdentity(options), reference = JSON.parse(await fs.readFile(options.identityFile + '.state-v2/reference.json'));
  const next = join(reference.epoch, 'next'), open = fs.open, rename = fs.rename;
  const assignment = { id: 'owned-assignment', secret: 'owned-control-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
  let committed = false;
  const mocks = [
    t.mock.method(fs, 'rename', async (...args) => { const result = await rename(...args); if (args[1] === next) committed = true; return result; }),
    t.mock.method(fs, 'open', async (...args) => {
      if (committed && args[0] === join(next, 'entry.json')) throw Object.assign(new Error('CONTROLLED_POST_COMMIT_READ_FAILURE'), { code: 'EIO' });
      return open(...args);
    }),
  ];
  syncBuiltinESMExports(); t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); });
  const save = value => saveRegisteredClientIdentity({ ...options, ...pending, ...value });
  await assert.rejects(save(assignment), { code: 'RELAY_IDENTITY_COMMIT_UNCONFIRMED', externalOutcome: 'unknown' });
  for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports();
  assert.deepEqual(await readRegisteredClientIdentity(options), assignment);
  await save(assignment); await assert.rejects(save({ ...assignment, id: 'different-assignment' }), /changed unexpectedly/);
  assert.equal(JSON.parse(await fs.readFile(options.identityFile + '.state-v2/reference.json')).generation, reference.generation);
});

test('a prepublication permission failure retains its definite local error and original pending generation', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'relay-prepublish-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { identityFile: join(root, 'identity.json'), relayUrl: 'https://relay.example.test',
    gatewaySecret: 'owned-internal-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
  const pending = await prepareClientIdentity(options), open = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    if (args[1] === 'wx' && String(args[0]).endsWith('entry.json')) throw Object.assign(new Error('CONTROLLED_PRE_COMMIT_DENIAL'), { code: 'EACCES' });
    return open(...args);
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(saveRegisteredClientIdentity({ ...options, ...pending, id: 'owned-assignment',
    secret: 'owned-control-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' }), { code: 'EACCES' });
  mocked.mock.restore(); syncBuiltinESMExports();
  assert.equal((await readClientIdentityState(options)).status, 'pending');
  assert.deepEqual(await prepareClientIdentity(options), pending);
  await assert.rejects(saveRegisteredClientIdentity({ ...options, ...pending, id: 'owned-assignment', secret: 'short' }),
    /Invalid registered client credentials/);
});

for(const mode of ['lstat-missing','named-reopen-missing','permission-denied','same-byte-replacement']){
  test(`legacy cleanup deterministically handles ${mode} after the original destination is verified`,async t=>{
    const root=await fs.mkdtemp(join(tmpdir(),'relay-cleanup-boundary-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const legacyIdentityFile=join(root,'legacy.json'),identityFile=join(root,'identity.json');
    const relayUrl='https://relay.example.test',gatewaySecret='owned-internal-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const assignment={id:'owned-cleanup-gateway',secret:'owned-control-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'};
    const original=JSON.stringify({version:1,relayOrigin:relayUrl,
      gatewaySecretHash:createHash('sha256').update(gatewaySecret).digest('hex'),...assignment})+'\n';
    await fs.writeFile(legacyIdentityFile,original,{mode:0o600});
    const originalOpen=fs.open,originalLstat=fs.lstat,platform=Object.getOwnPropertyDescriptor(process,'platform');
    let published=false,tailStats=0,injected=false;
    const mocks=[
      t.mock.method(fs,'lstat',async(...args)=>{
        const value=await originalLstat(...args);
        if(published&&args[0]===legacyIdentityFile){
          tailStats++;
          if(tailStats===1&&mode==='lstat-missing'){injected=true;await fs.unlink(legacyIdentityFile);}
          if(tailStats===1&&mode==='same-byte-replacement'){
            injected=true;await fs.rename(legacyIdentityFile,legacyIdentityFile+'.retained');
            await fs.writeFile(legacyIdentityFile,original,{mode:0o600,flag:'wx'});
          }
          if(tailStats===2&&mode==='permission-denied'){
            injected=true;throw Object.assign(new Error('owned cleanup access denied'),{code:'EACCES'});
          }
        }
        return value;
      }),
      t.mock.method(fs,'open',async(...args)=>{
        if(published&&args[0]===legacyIdentityFile&&mode==='named-reopen-missing'){
          injected=true;await fs.unlink(legacyIdentityFile);
        }
        const file=await originalOpen(...args);
        if(args[0]===identityFile&&!published){
          const close=file.close.bind(file);
          t.mock.method(file,'close',async()=>{
            await close();published=true;
            // Exercise only the Windows tail reopen; initialization uses this
            // host's real path and publication APIs.
            if(mode==='named-reopen-missing')Object.defineProperty(process,'platform',{...platform,value:'win32'});
          });
        }
        return file;
      }),
    ];
    const restore=()=>{
      for(const mock of mocks)mock.mock.restore();syncBuiltinESMExports();Object.defineProperty(process,'platform',platform);
    };
    syncBuiltinESMExports();t.after(restore);
    const options={identityFile,legacyIdentityFile,relayUrl,gatewaySecret};
    try{
      if(mode==='permission-denied')await assert.rejects(prepareInstanceIdentityFile(options),{code:'EACCES'});
      else if(mode==='same-byte-replacement')await assert.rejects(prepareInstanceIdentityFile(options),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
      else assert.equal(await prepareInstanceIdentityFile(options),identityFile);
    }finally{restore();}
    assert.equal(injected,true);
    assert.deepEqual(await readRegisteredClientIdentity({identityFile,relayUrl,gatewaySecret}),assignment);
    if(mode.endsWith('missing')){
      await assert.rejects(fs.lstat(legacyIdentityFile),{code:'ENOENT'});
      assert.equal(await prepareInstanceIdentityFile(options),identityFile);
    }else assert.equal(await fs.readFile(legacyIdentityFile,'utf8'),original);
  });
}
