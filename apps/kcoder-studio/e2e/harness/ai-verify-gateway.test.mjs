import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, writeFile, rm } from 'node:fs/promises';
import { finishUnpublishedGatewaySession } from '../../renderer/scripts/ai-verify.mjs';
import { gatewayVerificationOptions, prepareGatewayWorkspace, resumeGatewayVerificationRun, startOwnedDisplay, xauthorityRecord } from './ai-verify-gateway.mjs';
import { RunContext, appRoot, waitFor } from './run-context.mjs';
import { resolve } from 'node:path';

test('Gateway mode requires explicit current Tauri, KCoder and renderer inputs', async () => {
  await assert.rejects(gatewayVerificationOptions({}), /requires --tauri-bin/);
  await assert.rejects(gatewayVerificationOptions({ 'tauri-bin': '/tmp/app' }), /requires --kcoder-bin/);
  await assert.rejects(gatewayVerificationOptions({ 'tauri-bin': '/tmp/app', 'kcoder-bin': '/tmp/kcoder' }), /requires --renderer-root/);
});

test('Gateway mode does not accept caller-owned origins, credentials or displays', async () => {
  for (const name of ['display', 'gateway-origin', 'gateway-token', 'control-url']) {
    await assert.rejects(gatewayVerificationOptions({ [name]: 'foreign-resource' }), /not accepted/);
  }
});

test('reply fault injection must be explicitly enabled', async () => {
  await assert.rejects(gatewayVerificationOptions({ 'drop-save-reply': 'false' }), /explicitly enabled/);
  await assert.rejects(gatewayVerificationOptions({ 'delay-cancel-reply': 'false' }), /explicitly enabled/);
});

test('controller handoff refuses a broad or foreign cleanup directory', async () => {
  await assert.rejects(resumeGatewayVerificationRun('/', 'a'.repeat(64)), /only resume its owned run directory/);
  await assert.rejects(resumeGatewayVerificationRun(appRoot, 'a'.repeat(64)), /only resume its owned run directory/);
});

test('an unpublished controller timeout removes the session secret even when finish throws', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'unpublished-controller-cleanup' });
  const sessionPath = resolve(context.runRoot, 'session.json');
  const failure = new Error('controller startup timed out');
  try {
    await writeFile(sessionPath, JSON.stringify({ status: 'starting', token: 'isolated-test-secret' }), { mode: 0o600 });
    await assert.rejects(finishUnpublishedGatewaySession(context, sessionPath, failure), error => error === failure);
    const stopped = JSON.parse(await readFile(sessionPath, 'utf8'));
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.token, undefined);
    assert.equal(stopped.startupError, failure.message);
    assert.equal(stopped.cleanupError, undefined);
    await assert.rejects(access(context.stateDir));
  } finally {
    if (!context.finished) await context.finish('failed', null, failure).catch(() => {});
    await rm(sessionPath, { force: true });
  }
});

test('Gateway workspace has its own Git boundary instead of discovering the parent repository', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'gateway-workspace-boundary' });
  try {
    const workspace = await prepareGatewayWorkspace(context);
    await access(resolve(workspace, '.git/HEAD'));
    await access(resolve(workspace, 'Cargo.toml'));
    assert.ok(workspace.startsWith(context.pathInState('workspaces')));
    await context.finish('passed', { independentGitBoundary: true });
  } catch (error) {
    if (!context.finished) await context.finish('failed', null, error);
    throw error;
  }
});

test('Xvfb gets a fresh authenticated display and its exact process is cleaned', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'owned-display-lifecycle' });
  try {
    const owned = await startOwnedDisplay(context);
    assert.match(owned.display, /^:\d+$/);
    assert.ok(owned.child.pid > 0);
    assert.ok((await readFile(owned.authority)).includes(Buffer.from(owned.display.slice(1))));
    await context.finish('passed', { authenticatedDisplay: true });
    await assert.rejects(access(context.stateDir));
    const manifest = JSON.parse(await readFile(`${context.runRoot}/manifest.json`, 'utf8'));
    assert.equal(manifest.status, 'passed');
    assert.ok(manifest.cleanupSteps.every(step => step.status === 'completed'));
  } catch (error) {
    if (!context.finished) await context.finish('failed', null, error);
    throw error;
  }
});

test('owned display authorization has a private cookie and never accepts a display address', () => {
  const cookie = Buffer.alloc(16, 42);
  const record = xauthorityRecord('123', cookie);
  assert.equal(record.readUInt16BE(0), 65535);
  assert.ok(record.includes(Buffer.from('123')));
  assert.ok(record.includes(Buffer.from('MIT-MAGIC-COOKIE-1')));
  assert.deepEqual(record.subarray(-16), cookie);
  for (const value of [':0', 'localhost:0', '-1', '', '123456']) {
    assert.throws(() => xauthorityRecord(value, cookie), /Invalid owned X display/);
  }
});

test('stopping an already closed session is idempotent but cleanup failures stay failures', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'gateway-stop-outcome' });
  try {
    for (const [name, extra, expected] of [
      ['clean', {}, 0],
      ['failed', { cleanupError: 'owned process survived cleanup' }, 1],
      ['qa-failed', { verificationError: 'unexpected verification action failed' }, 1],
    ]) {
      const sessionPath = await context.writeStateJson(`${name}.json`, { gateway: true, status: 'stopped', ...extra });
      const child = context.spawnOwned(`stop-${name}`, process.execPath, [
        resolve(appRoot, 'renderer/scripts/ai-verify.mjs'), 'stop', '--session', sessionPath,
      ]);
      await waitFor(() => child.exitCode !== null, 5_000, 'closed-session stop');
      assert.equal(child.exitCode, expected);
    }
    await context.finish('passed', { idempotentStop: true, cleanupFailureVisible: true });
  } catch (error) {
    if (!context.finished) await context.finish('failed', null, error);
    throw error;
  }
});

test('Gateway scenario opt-in accepts only the bounded subagent fixture', async () => {
  await assert.rejects(gatewayVerificationOptions({ scenario: 'untrusted-command' }), /Unsupported.*scenario/);
  await assert.rejects(gatewayVerificationOptions({ scenario: 'subagent-trace' }), /requires --tauri-bin/);
});

test('provider fixture accepts an opt-in flag, never a caller endpoint', async () => {
  await assert.rejects(gatewayVerificationOptions({ 'provider-fixture': 'http://external.invalid' }), /explicitly enabled/);
  await assert.rejects(gatewayVerificationOptions({ 'provider-fixture': 'true' }), /requires --tauri-bin/);
});

test('continuation fixture cannot inject endpoints or combine incompatible scenarios', async () => {
  await assert.rejects(gatewayVerificationOptions({ 'continuation-fixture': 'https://example.invalid' }), /explicitly enabled/);
  await assert.rejects(gatewayVerificationOptions({ 'continuation-fixture': 'true', scenario: 'subagent-trace' }), /cannot be combined/);
  await assert.rejects(gatewayVerificationOptions({ 'continuation-fixture': 'true' }), /requires --tauri-bin/);
});
