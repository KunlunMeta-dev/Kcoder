import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pinnedNativeSshLaunch } from './pinned-ssh-launch.mjs';
import { normalizeServer, launchSpec, storedServer, publicServer } from '../server-config.js';

const reference = { targetPlatform: 'linux', expectedNativeSha256: 'a'.repeat(64) };
test('Linux image gate holds the exact hashed FD through exec and pins the existing SSH host', () => {
  const result = pinnedNativeSshLaunch({ runtime: 'kcoder', transport: 'ssh', host: 'owned-target',
    command: '/opt/owned/kcoder', remoteCwd: '/tmp/owned' }, reference);
  assert.ok(result.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(result.args.at(-1).includes('/usr/bin/sha256sum /proc/self/fd/3'));
  assert.ok(result.args.at(-1).includes('exec /proc/self/fd/3'));
  for (const target of [{ command: 'kcoder' }, { remotePlatform: 'windows' }, { security: { identity: {} } }])
    assert.throws(() => pinnedNativeSshLaunch({ runtime: 'kcoder', transport: 'ssh', host: 'owned-target',
      command: '/opt/owned/kcoder', remoteCwd: '/tmp/owned', ...target }, reference));
});

test('Windows image gate holds the image without write/delete sharing and quotes literal arguments', () => {
  const target = { runtime: 'kcoder', transport: 'ssh', host: 'owned-target', remotePlatform: 'windows',
    command: "D:\\Owned 'Area\\kcoder.exe", remoteCwd: 'D:\\Owned $(literal) & text\\workspace' };
  const result = pinnedNativeSshLaunch(target, { ...reference, targetPlatform: 'windows' });
  const script = Buffer.from(result.args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('[IO.FileShare]::Read'));
  assert.ok(script.includes("'D:\\Owned ''Area\\kcoder.exe'"));
  assert.ok(script.includes("'D:\\Owned $(literal) & text\\workspace'"));
  assert.ok(script.indexOf('ComputeHash') < script.indexOf('[Console]::Out.WriteLine'));
});

test('explicit Windows target survives normalization, persistence and safe launch without changing legacy Linux', () => {
  const defaults = { appServerBin: '/opt/kcoder', workspace: '/tmp' };
  const target = normalizeServer({ id: 'windows', label: 'Owned Windows', runtime: 'kcoder', transport: 'ssh', host: 'owned-target',
    remotePlatform: 'windows', command: 'D:\\Owned Area\\kcoder.exe', workspace: 'D:\\Owned Area\\workspace' }, defaults);
  assert.equal(target.remotePlatform, 'windows');
  assert.equal(storedServer(target).remotePlatform, 'windows');
  assert.equal(publicServer(target).remotePlatform, 'windows');
  const spec = launchSpec(target, { workspacePath: 'D:\\Owned Area\\other workspace' });
  assert.ok(spec.args.includes('-EncodedCommand'));
  const script = Buffer.from(spec.args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("'D:\\Owned Area\\other workspace'"));
  const legacy = normalizeServer({ id: 'linux', label: 'Owned Linux', transport: 'ssh', host: 'owned-target', command: 'kcoder', workspace: '/tmp/owned' }, defaults);
  assert.equal(legacy.remotePlatform, undefined);
  assert.deepEqual(launchSpec(legacy).args.slice(-4), ['kcoder', '--cwd', '/tmp/owned', 'app-server']);
});


test('the held Linux image starts in the selected owned target directory, before the ready gate',
  {skip:process.platform!=='linux'}, async () => {
    const root=await mkdtemp(join(tmpdir(),'kcoder-native-cwd-'));
    try {
      const login=join(root,'login'), selected=join(root,'selected'), program=join(root,'owned-image');
      await mkdir(login,{mode:0o700});await mkdir(selected,{mode:0o700});
      // An owned shell fixture observes actual process cwd. It proves launch
      // semantics only, never Native installation or Receiver authorization.
      const code="#!/bin/sh\nprintf '%s\\n' \"$PWD\"\n";
      await writeFile(program,code,{mode:0o700});
      const pin=createHash('sha256').update(code).digest('hex');
      const target={runtime:'kcoder',transport:'ssh',host:'owned-target',command:program,remoteCwd:selected};
      const run=async spec=>promisify(execFile)('/bin/sh',['-c',spec.args.slice(-3).join(' ')],{cwd:login,timeout:5000});
      const spec=pinnedNativeSshLaunch(target,{...reference,expectedNativeSha256:pin});
      const result=await run(spec);
      assert.deepEqual(result.stdout.trim().split('\n'),[spec.ready,selected]);
      const missing=pinnedNativeSshLaunch({...target,remoteCwd:join(root,'missing')},{...reference,expectedNativeSha256:pin});
      await assert.rejects(run(missing),error=>error.stdout==='', 'A failed directory change cannot publish ready or execute in the login home');
    } finally {await rm(root,{recursive:true,force:true});}
  });

test('fixed remote working directories remain literal and validated on both platforms', () => {
  const target={runtime:'kcoder',transport:'ssh',host:'owned-target',remotePlatform:'windows',
    command:'D:\\Owned Area\\kcoder.exe',remoteCwd:"D:\\Owned '$(literal) & text\\workspace"};
  const spec=pinnedNativeSshLaunch(target,{...reference,targetPlatform:'windows'});
  const script=Buffer.from(spec.args.at(-1),'base64').toString('utf16le');
  const change="Set-Location -LiteralPath 'D:\\Owned ''$(literal) & text\\workspace'";
  assert.ok(script.includes(change));
  assert.ok(script.includes('[Environment]::CurrentDirectory=(Get-Location).ProviderPath'));
  assert.ok(script.indexOf('ComputeHash')<script.indexOf(change));
  assert.ok(script.indexOf(change)<script.indexOf('[Console]::Out.WriteLine'));
  for(const cwd of ['/tmp/owned;touch_bad','/tmp/$(bad)','relative'])
    assert.throws(()=>pinnedNativeSshLaunch({...target,remotePlatform:'linux',command:'/owned/kcoder',remoteCwd:cwd},reference));
});

test('fixed original reader forwards the exact selected Provider profile for explicit native validation', async () => {
  const { pinnedNativeSshReadLaunch } = await import('./pinned-ssh-launch.mjs');
  const target = { transport: 'ssh', runtime: 'kcoder', host: 'owned-host', command: '/opt/owned/kcoder',
    remoteCwd: '/tmp/owned-workspace', profile: 'OwnedProvider' };
  const reference = { targetPlatform: 'linux', expectedNativeSha256: 'a'.repeat(64) };
  assert.match(pinnedNativeSshLaunch(target, reference).args.at(-1), /--profile/);
  const reader = pinnedNativeSshReadLaunch(target, reference).args.at(-1);
  assert.match(reader, /--internal-native-remote-read-v1/);
  assert.match(reader, /--profile/);
  assert.match(reader, /OwnedProvider/);
});
