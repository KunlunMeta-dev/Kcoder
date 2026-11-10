import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { validateSecurityOptions } from './windows-migration-security.mjs';
import { ownedStopScript } from './windows-package-probe.mjs';
import { prepareSuiteArtifacts, runNode } from '../run-all.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';

const valid = { consent: '1', target: 'owned-host', parent: 'D:\\', helper: '/owned/helper.exe', helperSha256: 'a'.repeat(64), baselineSource: 'b'.repeat(40) };
test('real vault acceptance requires explicit identity, consent and a non-C native parent', () => {
  assert.doesNotThrow(() => validateSecurityOptions(valid));
  for (const field of Object.keys(valid)) assert.throws(() => validateSecurityOptions({ ...valid, [field]: undefined }));
  for (const parent of ['C:\\', 'relative', '\\\\server\\share', 'D:\\bad\npath']) assert.throws(() => validateSecurityOptions({ ...valid, parent }));
});
test('owned native helper stop verifies its exact executable and process-start identity', () => {
  const script = ownedStopScript('D:\\owned-root', 'owner', 'security-helper.exe');
  assert.match(script, /security-helper\.exe/); assert.match(script, /process-start-time/);
  assert.ok(script.indexOf('Ownership mismatch') < script.indexOf('taskkill'));
  assert.ok(script.indexOf('Process identity changed') < script.indexOf('taskkill'));
  assert.doesNotMatch(script, /Directory\]::Delete|taskkill\s+\/IM/);
  assert.throws(() => ownedStopScript('D:\\owned-root', 'owner', "bad'leaf"));
});

test('native security acceptance retains its pinned helper without building unrelated artifacts', async () => {
  await prepareSuiteArtifacts(['suites/gateway/windows-migration-security.e2e.mjs'], {
    run: async () => assert.fail('pinned helper acceptance must not build unrelated product source'),
  });
});

test('native security inputs are restricted to the selected suite without forwarding provider secrets', async () => {
  const suite = 'suites/gateway/windows-migration-security.e2e.mjs';
  const selected = {
    KCODER_E2E_WINDOWS_MIGRATION_SECURITY: '1',
    KCODER_E2E_WINDOWS_SSH_TARGET: 'owned-host',
    KCODER_E2E_WINDOWS_PROBE_PARENT: 'D:\\',
    KCODER_E2E_WINDOWS_SECURITY_HELPER: '/owned/helper.exe',
    KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256: 'a'.repeat(64),
    KCODER_E2E_WINDOWS_SECURITY_BASELINE_SOURCE: 'b'.repeat(40),
    AWS_SECRET_ACCESS_KEY: 'not-for-a-security-probe',
  };
  const child = new EventEmitter(); child.pid = 4242;
  let environment;
  const result = runNode(suite, {
    environment: selected,
    buildEnvironment: names => Object.fromEntries(names.filter(name => selected[name]).map(name => [name, selected[name]])),
    spawnChild: (_command, _args, options) => { environment = options.env; return child; },
    identityFactory: () => ({ pid: 4242 }), signalTarget: new EventEmitter(), treeAlive: async () => false,
  });
  child.emit('exit', 0, null); assert.equal(await result, 0);
  for (const [name, value] of Object.entries(selected))
    assert.equal(environment[name], name === 'AWS_SECRET_ACCESS_KEY' ? undefined : value);
  for (const name of ['KCODER_E2E_WINDOWS_MIGRATION_SECURITY', 'KCODER_E2E_WINDOWS_SECURITY_HELPER_SHA256'])
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
});
