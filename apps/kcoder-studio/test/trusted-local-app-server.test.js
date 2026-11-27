import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appServerEnvironment, nativeComponentParentAttempt, workspaceReceiptParentAttempt } from '../src/server-config.js';
import { captureTrustedLocalAppServer } from '../src/trusted-local-app-server.js';

test('internal lifecycle pins the deployment executable through exec and rejects custom commands/path replacement', { skip: !['linux','darwin'].includes(process.platform) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kc-trusted-elf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'kcoder'), custom = join(root, 'custom');
  await copyFile('/usr/bin/true', binary); await copyFile('/usr/bin/false', custom);
  const trusted = captureTrustedLocalAppServer(binary);
  assert.ok(trusted); t.after(() => trusted.close());
  const target = { runtime: 'kcoder', transport: 'local', command: binary };
  assert.equal(trusted.matches(target), true);
  for (const other of [{ ...target, command: custom }, { ...target, transport: 'ssh' }, { ...target, security: {} }]) assert.equal(trusted.matches(other), false);
  const spec = trusted.launch(target, { args: [], cwd: root });
  await rename(custom, binary);
  assert.equal(trusted.matches(target), false);
  assert.throws(() => trusted.launch(target, { args: [] }));
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: spec.stdio });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [code, signal] = await once(child, 'close');
  assert.equal(code, 0, 'exec uses the original pinned true image, not its replacement');
  assert.equal(signal, null);
  trusted.close(); assert.equal(trusted.matches(target), false);
});

test('Darwin component ownership does not enable retained receipt migration', () => {
  const target={runtime:'kcoder',transport:'local',command:'/owned/kcoder'};
  assert.equal(nativeComponentParentAttempt(target,'darwin'),true);
  assert.equal(workspaceReceiptParentAttempt(target,'darwin'),false);
  assert.equal(nativeComponentParentAttempt({...target,security:{}},'darwin'),false);
  assert.equal(nativeComponentParentAttempt({...target,transport:'ssh'},'darwin'),false);
});

test('Darwin peer inode pins do not invalidate one another', {skip:process.platform!=='darwin'}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'kc-trusted-peers-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const binary=join(root,'kcoder');await copyFile('/usr/bin/true',binary);
  const first=captureTrustedLocalAppServer(binary);assert.ok(first);t.after(()=>first.close());
  const second=captureTrustedLocalAppServer(binary);assert.ok(second);t.after(()=>second.close());
  const target={runtime:'kcoder',transport:'local',command:binary};
  assert.equal(first.matches(target),true);assert.equal(second.matches(target),true);
  second.close();assert.equal(first.matches(target),true);
});

test('scripts, missing binaries, bare PATH names and unsupported hosts receive no internal capability', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kc-untrusted-exec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'script'); await writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(captureTrustedLocalAppServer(script), null);
  assert.equal(captureTrustedLocalAppServer(join(root, 'missing')), null);
  assert.equal(captureTrustedLocalAppServer('kcoder'), null);
  assert.equal(captureTrustedLocalAppServer('/usr/bin/true', 'win32'), null);
});


test('only the pinned deployment image inherits private verifier material', { skip: !['linux','darwin'].includes(process.platform) }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kc-trusted-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'kcoder'), custom = join(root, 'custom');
  await copyFile(process.execPath, binary); await copyFile(process.execPath, custom);
  const trusted = captureTrustedLocalAppServer(binary);
  assert.ok(trusted); t.after(() => trusted.close());
  const verifier = { version: 1, gatewayNamespaceId: 'a'.repeat(64), key: 'b'.repeat(64) };
  for (const command of [binary, custom]) {
    const target = { runtime: 'kcoder', transport: 'local', command };
    const allowed = trusted.matches(target);
    const args=['-e', "for(const [key,value] of Object.entries(process.env)) console.log(key+'='+value)"];
    const spec = allowed ? trusted.launch(target, { args }) : { command, args, stdio: ['pipe', 'pipe', 'pipe'] };
    const child = spawn(spec.command, spec.args, { stdio: spec.stdio,
      env: appServerEnvironment({ KCODER_PRIVATE_RETENTION_VERIFIER_V1: 'ambient-forgery' }, {}, 'localOs', allowed ? verifier : undefined) });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; });
    const [code] = await once(child, 'close'); assert.equal(code, 0);
    const encoded = output.split('\n').find(line => line.startsWith('KCODER_PRIVATE_RETENTION_VERIFIER_V1='));
    assert.equal(Boolean(encoded), command === binary);
    if (encoded) assert.deepEqual(JSON.parse(Buffer.from(encoded.split('=')[1].slice(3), 'base64url')), verifier);
  }
});
