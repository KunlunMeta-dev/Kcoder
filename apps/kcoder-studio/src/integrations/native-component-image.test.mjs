import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { consumeNativeComponentImageStartup, nativeComponentImageEnvironmentKey as key,
  nativeWindowsComponentEnvironment } from './native-component-image.mjs';

test('the private pin is consumed once and aliases disappear before invalid input can fail', () => {
  const pin = {schemaVersion:1,abiVersion:1,addonPath:resolve(tmpdir(),'owned-image.node'),addonSha256:'a'.repeat(64),programSha256:'b'.repeat(64)};
  const environment = {[key]:Buffer.from(JSON.stringify(pin)).toString('base64url'),[key.toLowerCase()]:'ambient-forgery',PATH:'/controlled'};
  assert.deepEqual(consumeNativeComponentImageStartup(environment),pin);
  assert.deepEqual(environment,{PATH:'/controlled'});
  assert.equal(consumeNativeComponentImageStartup(environment),null);
  const bad = {[key]:'invalid!', [key.toLowerCase()]:'also-invalid'};
  assert.throws(() => consumeNativeComponentImageStartup(bad));
  assert.deepEqual(bad,{});
});

test('configuration or a JSON object with a true matches method cannot produce a component parent', () => {
  const target = {runtime:'kcoder',transport:'local',command:resolve(tmpdir(),'owned-cli.exe')};
  assert.throws(() => nativeWindowsComponentEnvironment({matches:()=>true},target),/NATIVE_COMPONENT_IMAGE_UNAVAILABLE/);
  assert.throws(() => nativeWindowsComponentEnvironment(JSON.parse('{"version":1,"verified":true}'),target),/NATIVE_COMPONENT_IMAGE_UNAVAILABLE/);
});
