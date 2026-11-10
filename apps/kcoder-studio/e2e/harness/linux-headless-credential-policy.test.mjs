import assert from 'node:assert/strict';
import test from 'node:test';
import { headlessCredentialEnvironment, headlessKeyringError, assertHeadlessKeyringRejected,
  assertHeadlessGroupSettled, assertHeadlessPublic } from './linux-headless-credential-policy.mjs';

test('owned unavailable DBus and XDG overrides cannot inherit a desktop or credential environment', () => {
  const names = ['DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','DBUS_SYSTEM_BUS_ADDRESS','DBUS_STARTER_ADDRESS','XDG_RUNTIME_DIR','HOME','ANTHROPIC_API_KEY'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'PERSONAL_ENV_NOT_FOR_CHILD';
    const env = headlessCredentialEnvironment('/tmp/owned-headless-unit', '/tmp/owned-headless-unit/profile');
    assert.equal(env.HOME, '/tmp/owned-headless-unit/home');
    assert.equal(env.XDG_RUNTIME_DIR, '/tmp/owned-headless-unit/runtime');
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/tmp/owned-headless-unit/runtime/absent-session-bus.sock');
    for (const name of ['DISPLAY','WAYLAND_DISPLAY','DBUS_STARTER_ADDRESS','ANTHROPIC_API_KEY']) assert.equal(env[name], undefined);
    assert.equal(Object.values(env).includes('PERSONAL_ENV_NOT_FOR_CHILD'), false);
  } finally { for (const name of names) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
  assert.throws(() => headlessCredentialEnvironment('/tmp/owned-headless-unit', '/tmp/peer-profile'));
});
test('only the exact native unavailable failure qualifies; success, generic errors or result/error mixtures do not', () => {
  assert.equal(assertHeadlessKeyringRejected({ error: { code: -32047, message: headlessKeyringError } }), headlessKeyringError);
  for (const frame of [{ result: { passed: true } }, { error: { code: -32047, message: 'migration_operation_failed' } },
    { error: { code: -32603, message: headlessKeyringError } }, { result: {}, error: { code: -32047, message: headlessKeyringError } }])
    assert.throws(() => assertHeadlessKeyringRejected(frame));
});
test('worker stop and completed-with-issues cannot substitute complete group action receipts', () => {
  const state = { workerRunning: false, state: { job: { status: 'completed_with_issues', hasUnconfirmedOutcomes: false },
    batch: { totalActions: 3, committedActions: 3, unresolvedActions: 0 } } };
  assertHeadlessGroupSettled(state);
  for (const mutate of [v => { v.workerRunning = true; }, v => { v.state.batch.committedActions = 0; },
    v => { v.state.batch.unresolvedActions = 1; }, v => { v.state.job.hasUnconfirmedOutcomes = true; }]) {
    const bad = structuredClone(state); mutate(bad); assert.throws(() => assertHeadlessGroupSettled(bad));
  }
});
test('public projections reject either distinct Provider or MCP synthetic value without printing it', () => {
  assertHeadlessPublic({ safe: true }, ['SYNTHETIC_PROVIDER', 'SYNTHETIC_MCP']);
  for (const value of ['SYNTHETIC_PROVIDER', 'SYNTHETIC_MCP']) assert.throws(() => assertHeadlessPublic({ private: value },
    ['SYNTHETIC_PROVIDER','SYNTHETIC_MCP']), /headless_public_secret_leak/);
});


test('manual Linux leaf forwards only its own policy gate and reuses the explicitly pinned Native without a build', async () => {
  const { suiteEnvironmentNames } = await import('./runner-options.mjs');
  const { prepareSuiteArtifacts } = await import('../run-all.mjs');
  const { manualLiveSuites, modelIndependentSuites, registeredSuites } = await import('../suite-registry.mjs');
  const suite = 'suites/gateway/linux-headless-credentials.e2e.mjs';
  assert.ok(manualLiveSuites.includes(suite) && registeredSuites.includes(suite));
  assert.equal(modelIndependentSuites.includes(suite), false);
  for (const name of ['KCODER_E2E_LINUX_HEADLESS_CREDENTIALS','KCODER_E2E_LINUX_HEADLESS_NATIVE','KCODER_E2E_LINUX_HEADLESS_NATIVE_SHA256']) {
    assert.ok(suiteEnvironmentNames(suite).includes(name));
    assert.equal(suiteEnvironmentNames('suites/gateway/auth.e2e.mjs').includes(name), false);
  }
  const calls = []; await prepareSuiteArtifacts([suite], { run: async (...args) => calls.push(args) });
  assert.deepEqual(calls, []);
});
