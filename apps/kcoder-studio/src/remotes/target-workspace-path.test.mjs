import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeServer, storedServer } from '../server-config.js';
import { isTargetWorkspaceAbsolute, targetWorkspaceBrokerKey } from './target-workspace-path.mjs';

const windows = normalizeServer({ id: 'owned', label:'Owned', runtime:'kcoder', transport:'ssh', remotePlatform:'windows', host:'owned.invalid', user:'owner', command:'D:\\Owned Area\\launcher.exe', workspace:'D:\\Owned Area\\workspace' },{ platform:'linux' });
const signature = target => JSON.stringify(storedServer(target));
const key = (target, workspace) => targetWorkspaceBrokerKey(target, workspace, signature(target));

test('explicit Windows SSH workspace keys accept drive paths independently of the Gateway host', () => {
  let localCalls = 0;
  for (const value of ['D:\\Owned Area\\workspace', 'D:/Owned Area/workspace', 'D:\\独立\\workspace']) {
    assert.equal(isTargetWorkspaceAbsolute(windows, value, { platform: 'linux' }), true);
    assert.doesNotThrow(() => targetWorkspaceBrokerKey(windows, value, 'owned-signature', { platform: 'linux', realpath: () => { localCalls++; throw Error('remote path must not access host disk'); } }));
  }
  assert.equal(localCalls, 0);
  assert.equal(key(windows, 'D:/Owned Area/temporary/../workspace'), key(windows));
});

test('Windows remote UNC, devices, root-relative and drive-relative paths remain refused', () => {
  for (const value of ['D:workspace', 'relative', '\\\\server\\share', '\\\\?\\D:\\workspace', '\\root-relative', '/root-relative', 'D:\\bad\npath', 'D:\\wild*card']) {
    assert.equal(isTargetWorkspaceAbsolute(windows, value, { platform: 'linux' }), false, value);
    assert.throws(() => key(windows, value), /absolute workspace/);
  }
});

test('legacy POSIX remote paths and default-cwd sentinel retain their original semantics', () => {
  const target = normalizeServer({ id:'linux', label:'Owned Linux', runtime:'kcoder', transport:'ssh', host:'owned.invalid', command:'/owned/kcoder',workspace:'/srv/owned' },{platform:'linux'});
  assert.equal(isTargetWorkspaceAbsolute(target, '/srv/owned', { platform: 'win32' }), true);
  assert.equal(isTargetWorkspaceAbsolute(target, 'D:\\owned', { platform: 'linux' }), false);
  assert.equal(key(target, '/srv/temporary/../owned'), key(target));
  assert.throws(() => key(target, 'relative'), /absolute workspace/);
  const home = { ...target, remoteCwd: undefined };
  assert.equal(JSON.parse(key(home))[1], '<remote-default-cwd>');
  assert.notEqual(key(home), key(target, '/'));
});

test('local targets still use actual host realpath; Windows local UNC is not a remote selector', () => {
  const local = { transport: 'local', cwd: '/owned/link' }, calls = [];
  const value = targetWorkspaceBrokerKey(local, undefined, 'local', { platform: 'linux', realpath: path => { calls.push(path); return '/owned/real'; } });
  assert.deepEqual(JSON.parse(value), ['local', '/owned/real']);
  assert.deepEqual(calls, ['/owned/link']);
  assert.equal(isTargetWorkspaceAbsolute({ transport: 'local' }, '\\\\server\\share', { platform: 'win32' }), true);
  assert.throws(() => targetWorkspaceBrokerKey(local, 'relative', 'local'), /absolute workspace/);
});

test('target identity, Provider profile and whole workspace segments keep broker keys isolated', () => {
  const defaults = { platform: 'linux', appServerBin: '/owned/kcoder', workspace: '/owned' };
  const base = normalizeServer({ id: 'owner', label: 'Owned', runtime: 'kcoder', transport: 'ssh', host: 'owned.invalid', user: 'owner', remotePlatform: 'windows', command: 'D:\\Owned\\kcoder.exe', workspace: 'D:\\Owned\\workspace', profile: 'ProviderA' }, defaults);
  const peer = { ...base, id: 'peer' }, profile = { ...base, profile: 'ProviderB' };
  assert.notEqual(key(base), key(peer)); assert.notEqual(key(base), key(profile));
  assert.notEqual(key(base, 'D:\\Owned\\workspace'), key(base, 'D:\\Owned\\workspace-peer'));
  assert.notEqual(key(base), key({ ...base, remoteCwd: undefined }));
});
