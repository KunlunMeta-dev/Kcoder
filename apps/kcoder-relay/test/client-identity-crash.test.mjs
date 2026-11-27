import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, writeFile, copyFile, link, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as identity from '../src/client-identity.mjs';
import { removeRevokedRelayCredentials } from '../../kcoder-studio/src/gateway-relay-instance.js';

const relayUrl = 'https://relay.example.test';
const gatewaySecret = 'owned-gateway-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const assignment = id => ({ id, secret: 'owned-control-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-' + id });
const moduleUrl = new URL('../src/client-identity.mjs', import.meta.url).href;
const worker = `
  import fs from 'node:fs/promises';
  import { syncBuiltinESMExports } from 'node:module';
  const input=JSON.parse(process.argv[1]);
  const rename=fs.rename,link=fs.link,open=fs.open;let committed;
  function hit(kind,target,after){
    if(input.crash?.kind===kind&&input.crash.after===after&&String(target).endsWith(input.crash.suffix)){
      process.send({checkpoint:kind+(after?':after':':before')});process.kill(process.pid,'SIGKILL');
    }
  }
  fs.rename=async(source,target)=>{hit('rename',target,false);const value=await rename(source,target);if(input.failSyncAfter&&String(target).endsWith(input.failSyncAfter))committed=String(target);hit('rename',target,true);return value;};
  fs.link=async(source,target)=>{if(input.swapOnLink&&String(target)===input.swapOnLink.target){await rename(source,input.swapOnLink.held);await fs.writeFile(source,input.swapOnLink.bytes,{mode:0o600});}hit('link',target,false);const value=await link(source,target);hit('link',target,true);return value;};
  fs.open=async(...args)=>{const file=await open(...args);if(committed&&String(args[0])===committed.slice(0,committed.lastIndexOf('/')))file.sync=async()=>{throw Error('owned directory sync failure');};return file;};
  syncBuiltinESMExports();
  const api=await import(input.moduleUrl);
  process.send({ready:true});
  process.once('message',async()=>{
    try{const value=await api[input.operation](input.options);process.send({ok:true,status:value?.status,id:value?.id});}
    catch(error){process.send({ok:false,code:error.code,message:error.message});}
    process.disconnect();
  });
`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-identity-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, options: { identityFile: join(root, 'relay/client-identity.json'), relayUrl, gatewaySecret } };
}
async function child(t, input) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', worker, JSON.stringify({ moduleUrl, ...input })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let ready, settled, output = '', result;
  const initialized = new Promise(resolve => { ready = resolve; });
  const done = new Promise(resolve => { settled = resolve; });
  const timeout = setTimeout(() => process.kill('SIGKILL'), 8000);
  process.stderr.on('data', chunk => { output += chunk; });
  process.on('message', message => { if (message.ready) ready(); else result = message; });
  process.on('exit', (code, signal) => { clearTimeout(timeout); ready(); settled({ ...result, code: result?.code ?? code, signal, stderr: output }); });
  t.after(() => { if (process.exitCode === null && !process.killed) process.kill('SIGKILL'); });
  await initialized;
  return { start: () => process.send('start'), done };
}

// The production store is never touched: every worker receives an owned explicit path.
test('twelve real two-process save races accept exactly one different assignment', async t => {
  for (let trial = 0; trial < 12; trial++) {
    const f = await fixture(t), pending = await identity.prepareClientIdentity(f.options);
    const children = await Promise.all(['writer-a', 'writer-b'].map(id => child(t, { operation: 'saveRegisteredClientIdentity',
      options: { ...f.options, enrollmentToken: pending.enrollmentToken, ...assignment(id) } })));
    children.forEach(worker => worker.start());
    const outcomes = await Promise.all(children.map(worker => worker.done));
    assert.equal(outcomes.filter(value => value.ok).length, 1, JSON.stringify(outcomes));
    const saved = await identity.readRegisteredClientIdentity(f.options);
    assert.equal(saved.id, outcomes.find(value => value.ok).id);
  }
});

for (const after of [false, true]) {
  test(`SIGKILL ${after ? 'after' : 'before'} initial reference publication preserves a safe startup boundary`, { skip: process.platform === 'win32' ? 'requires real POSIX SIGKILL' : false }, async t => {
    const f = await fixture(t);
    const process = await child(t, { operation: 'prepareClientIdentity', options: f.options,
      crash: { kind: 'rename', suffix: '.state-v2', after } });
    process.start(); assert.equal((await process.done).signal, 'SIGKILL');
    const state = await identity.readClientIdentityState(f.options);
    assert.equal(state?.status ?? null, after ? 'pending' : null);
    const recovered = await identity.prepareClientIdentity(f.options);
    assert.equal(recovered.status, 'pending');
    assert.deepEqual(await identity.prepareClientIdentity(f.options), recovered);
    const directories = (await readdir(dirname(f.options.identityFile))).filter(name => name.startsWith('.relay-identity-generation-'));
    assert.equal(directories.length, after ? 1 : 2, 'unreferenced complete epochs are retained without adoption');
  });
  test(`SIGKILL ${after ? 'after' : 'before'} assignment commit reconciles the original proof`, { skip: process.platform === 'win32' ? 'requires real POSIX SIGKILL' : false }, async t => {
    const f = await fixture(t), pending = await identity.prepareClientIdentity(f.options);
    const process = await child(t, { operation: 'saveRegisteredClientIdentity', options: { ...f.options, ...pending, ...assignment('original') },
      crash: { kind: 'rename', suffix: '/next', after } });
    process.start(); assert.equal((await process.done).signal, 'SIGKILL');
    const recovered = await identity.prepareClientIdentity(f.options);
    assert.equal(recovered.status, after ? 'registered' : 'pending');
    if (!after) assert.equal(recovered.enrollmentToken, pending.enrollmentToken);
    await identity.saveRegisteredClientIdentity({ ...f.options, ...pending, ...assignment('original') });
    assert.deepEqual(await identity.readRegisteredClientIdentity(f.options), assignment('original'));
  });
  test(`SIGKILL ${after ? 'after' : 'before'} marker link leaves the same authoritative proof`, { skip: process.platform === 'win32' ? 'requires real POSIX SIGKILL' : false }, async t => {
    const f = await fixture(t);
    const process = await child(t, { operation: 'prepareClientIdentity', options: f.options,
      crash: { kind: 'link', suffix: 'client-identity.json', after } });
    process.start(); assert.equal((await process.done).signal, 'SIGKILL');
    const ref = JSON.parse(await readFile(f.options.identityFile + '.state-v2/reference.json'));
    const root = JSON.parse(await readFile(join(ref.epoch, 'entry.json')));
    const recovered = await identity.prepareClientIdentity(f.options);
    assert.equal(recovered.enrollmentToken, root.record.enrollmentToken);
    assert.equal((await stat(join(ref.epoch, 'entry.json'))).nlink, 1, 'credential entry never has a second hard link');
  });
}

test('revoke before the first prepare persists a deny anchor and never creates another generation', async t => {
  const f = await fixture(t);
  await removeRevokedRelayCredentials(f.root, f.options.identityFile);
  await assert.rejects(identity.prepareClientIdentity(f.options), { code: 'RELAY_IDENTITY_REVOKED' });
  assert.equal((await identity.readClientIdentityState(f.options)).status, 'revoked');
});

test('relocated legacy aliases share one deny authority and retain original credentials', async t => {
  const f = await fixture(t), source = join(f.root, 'legacy/identity.json');
  await mkdir(dirname(source), { mode: 0o700 });
  const bytes = JSON.stringify({ version: 1, relayOrigin: relayUrl, gatewaySecretHash: createHash('sha256').update(gatewaySecret).digest('hex'), ...assignment('original') });
  await writeFile(source, bytes, { mode: 0o600 });
  await identity.prepareInstanceIdentityFile({ identityFile: f.options.identityFile, legacyIdentityFile: source, relayUrl, gatewaySecret });
  assert.equal(await readFile(f.options.identityFile, 'utf8'), bytes);
  await identity.revokeClientIdentity({ identityFile: source });
  await assert.rejects(identity.readRegisteredClientIdentity(f.options), { code: 'RELAY_IDENTITY_REVOKED' });
  await assert.rejects(identity.prepareClientIdentity({ ...f.options, identityFile: source }), { code: 'RELAY_IDENTITY_REVOKED' });
});

test('the implicit durable default survives deletion of the old owned build target', async t => {
  const f = await fixture(t), source = join(f.root, 'apps/kcoder-relay/src/client-identity.mjs');
  await mkdir(dirname(source), { recursive: true, mode: 0o700 });
  await copyFile(new URL('../src/client-identity.mjs', import.meta.url), source);
  const previous = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.XDG_STATE_HOME = join(f.root, 'durable-state'); process.env.LOCALAPPDATA = join(f.root, 'durable-state');
  let api;
  try { api = await import(pathToFileURL(source).href); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const bytes = JSON.stringify({ version: 1, relayOrigin: relayUrl, gatewaySecretHash: createHash('sha256').update(gatewaySecret).digest('hex'), ...assignment('original') });
  await mkdir(dirname(api.LEGACY_DEFAULT_IDENTITY_FILE), { recursive: true, mode: 0o700 });
  await writeFile(api.LEGACY_DEFAULT_IDENTITY_FILE, bytes, { mode: 0o600 });
  assert.equal(await api.clientIdentityPresent(), true);
  const prepared = await api.prepareClientIdentity({ relayUrl, gatewaySecret });
  assert.equal(prepared.id, 'original');
  await rm(join(f.root, 'target'), { recursive: true });
  assert.deepEqual(await api.readRegisteredClientIdentity({ relayUrl, gatewaySecret }), assignment('original'));
  assert.equal(api.resolveIdentityFile({ KCODER_RELAY_IDENTITY_FILE: f.options.identityFile }), f.options.identityFile);
});

for (const corruption of ['reference symlink', 'credential hardlink', 'epoch replacement', 'empty reference', 'extra decision']) {
  test(`cold ${corruption} fails closed without new enrollment`, async t => {
    const f = await fixture(t); await identity.prepareClientIdentity(f.options);
    const pointer = f.options.identityFile + '.state-v2';
    const ref = JSON.parse(await readFile(join(pointer, 'reference.json')));
    const { rename, symlink } = await import('node:fs/promises');
    if (corruption === 'reference symlink') {
      const original = join(f.root, 'original-reference.json');
      await rename(join(pointer, 'reference.json'), original);
      await symlink(original, join(pointer, 'reference.json'));
    } else if (corruption === 'credential hardlink') {
      await link(join(ref.epoch, 'entry.json'), join(f.root, 'unexpected-alias'));
    } else if (corruption === 'epoch replacement') {
      await rename(ref.epoch, ref.epoch + '-original');
      await mkdir(ref.epoch, { mode: 0o700 });
      await copyFile(join(ref.epoch + '-original', 'entry.json'), join(ref.epoch, 'entry.json'));
    } else if (corruption === 'empty reference') {
      await rm(pointer, { recursive: true }); await mkdir(pointer, { mode: 0o700 });
    } else {
      await identity.saveRegisteredClientIdentity({ ...f.options, ...(await identity.prepareClientIdentity(f.options)), ...assignment('original') });
      await identity.revokeClientIdentity(f.options);
      await mkdir(join(ref.epoch, 'next/next/next'), { mode: 0o700 });
    }
    await assert.rejects(identity.prepareClientIdentity(f.options));
    await assert.rejects(identity.readRegisteredClientIdentity(f.options));
  });
}

test('a crashed old two-hardlink pending seed becomes a single-link authority without deleting unknown aliases', async t => {
  const f = await fixture(t), proof = 'original-proof-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  await mkdir(dirname(f.options.identityFile), { mode: 0o700 });
  const bytes = JSON.stringify({ version: 1, relayOrigin: relayUrl, gatewaySecretHash: createHash('sha256').update(gatewaySecret).digest('hex'), enrollmentToken: proof });
  await writeFile(f.options.identityFile, bytes, { mode: 0o600 });
  const oldTemporary = join(dirname(f.options.identityFile), 'unknown-legacy-temp');
  await link(f.options.identityFile, oldTemporary);
  const pending = await identity.prepareClientIdentity(f.options);
  assert.equal(pending.enrollmentToken, proof);
  const ref = JSON.parse(await readFile(f.options.identityFile + '.state-v2/reference.json'));
  assert.equal((await stat(join(ref.epoch, 'entry.json'))).nlink, 1);
  assert.equal(await readFile(oldTemporary, 'utf8'), bytes);
  await identity.saveRegisteredClientIdentity({ ...f.options, ...pending, ...assignment('original') });
  assert.deepEqual(await identity.readRegisteredClientIdentity({ ...f.options, requireSingleLink: true }), assignment('original'));
});

test('public phase reads have a fixed I/O bound, never scan garbage and never rewrite credentials', async t => {
  const f = await fixture(t), pending = await identity.prepareClientIdentity(f.options);
  await identity.saveRegisteredClientIdentity({ ...f.options, ...pending, ...assignment('original') });
  // Unknown candidates remain private garbage, not candidates for adoption.
  for (let n = 0; n < 40; n++) await mkdir(join(dirname(f.options.identityFile), '.relay-identity-candidate-unreferenced-' + n), { mode: 0o700 });
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const script = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    let opens=0;const original=fs.open;fs.open=(...args)=>{if(typeof args[1]==='string'&&args[1]!=='r')throw Error('write on read');opens++;return original(...args);};
    for(const name of ['readdir','writeFile','rename','link','unlink','mkdir','rm'])fs[name]=()=>{throw Error('unexpected '+name);};
    syncBuiltinESMExports();const api=await import(${JSON.stringify(moduleUrl)});
    for(let n=0;n<40;n++){const state=await api.readClientIdentityState(${JSON.stringify(f.options)});if(state.status!=='registered')throw Error('bad phase');}
    if(opens!==40*5)throw Error('unexpected open bound '+opens);console.log(JSON.stringify({reads:40,opens,writes:0,scans:0}));`;
  const outcome = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  assert.deepEqual(JSON.parse(outcome.stdout), { reads: 40, opens: 200, writes: 0, scans: 0 });
  await identity.revokeClientIdentity(f.options);
  assert.equal((await identity.readClientIdentityState(f.options)).status, 'revoked', 'reads do not cache an allow verdict');
});

test('twelve real save/revoke process races finish with an irreversible deny',async t=>{
  for(let trial=0;trial<12;trial++){
    const f=await fixture(t),pending=await identity.prepareClientIdentity(f.options);
    const save=await child(t,{operation:'saveRegisteredClientIdentity',options:{...f.options,...pending,...assignment('original')}});
    const revoke=await child(t,{operation:'revokeClientIdentity',options:f.options});
    save.start();revoke.start();
    const outcomes=await Promise.all([save.done,revoke.done]);
    assert.equal(outcomes[1].ok,true,JSON.stringify(outcomes));
    assert.equal((await identity.readClientIdentityState(f.options)).status,'revoked');
    await assert.rejects(identity.saveRegisteredClientIdentity({...f.options,...pending,...assignment('late')}),{code:'RELAY_IDENTITY_REVOKED'});
  }
});

for(const after of [false,true])test(`SIGKILL ${after?'after':'before'} revoke publication never permits resurrection`,{skip:process.platform==='win32'?'requires POSIX SIGKILL':false},async t=>{
  const f=await fixture(t),pending=await identity.prepareClientIdentity(f.options);
  const revoke=await child(t,{operation:'revokeClientIdentity',options:f.options,crash:{kind:'rename',suffix:'/next',after}});
  revoke.start();assert.equal((await revoke.done).signal,'SIGKILL');
  assert.equal((await identity.readClientIdentityState(f.options)).status,after?'revoked':'pending');
  // A missing receipt before commit remains unconfirmed; retry only the same deny.
  await identity.revokeClientIdentity(f.options);
  await assert.rejects(identity.saveRegisteredClientIdentity({...f.options,...pending,...assignment('late')}),{code:'RELAY_IDENTITY_REVOKED'});
});

test('lost post-publication directory sync is unconfirmed and reconciliation preserves the committed assignment',async t=>{
  const f=await fixture(t),pending=await identity.prepareClientIdentity(f.options);
  const save=await child(t,{operation:'saveRegisteredClientIdentity',options:{...f.options,...pending,...assignment('original')},failSyncAfter:'/next'});
  save.start();const outcome=await save.done;
  assert.equal(outcome.ok,false);assert.equal(outcome.code,'RELAY_IDENTITY_COMMIT_UNCONFIRMED');
  assert.deepEqual(await identity.readRegisteredClientIdentity(f.options),assignment('original'));
  await identity.saveRegisteredClientIdentity({...f.options,...pending,...assignment('original')});
  await assert.rejects(identity.saveRegisteredClientIdentity({...f.options,...pending,...assignment('different')}),/changed unexpectedly/);
});

test('legacy read-to-link substitution cannot replace the validated assignment',async t=>{
  const f=await fixture(t),source=join(f.root,'legacy/identity.json'),held=join(f.root,'legacy/held-original.json');
  await mkdir(dirname(source),{mode:0o700});
  const record={version:1,relayOrigin:relayUrl,gatewaySecretHash:createHash('sha256').update(gatewaySecret).digest('hex'),...assignment('original')};
  const original=JSON.stringify(record);await writeFile(source,original,{mode:0o600});
  const substitute=JSON.stringify({...record,...assignment('substituted')});
  const migrate=await child(t,{operation:'prepareInstanceIdentityFile',options:{...f.options,legacyIdentityFile:source},
    swapOnLink:{target:f.options.identityFile,held,bytes:substitute}});
  migrate.start();assert.equal((await migrate.done).ok,false);
  assert.equal(await readFile(held,'utf8'),original);
  assert.equal(await readFile(source,'utf8'),substitute,'failure cannot delete the replacement source');
  await assert.rejects(identity.readRegisteredClientIdentity(f.options));
  const reference=JSON.parse(await readFile(f.options.identityFile+'.state-v2/reference.json'));
  assert.equal(JSON.parse(await readFile(join(reference.epoch,'entry.json'))).record.id,'original');
});
