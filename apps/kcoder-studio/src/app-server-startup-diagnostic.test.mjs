import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { nativeStartupDiagnostic } from '../shared/nativeStartupDiagnostic.mjs';
import { NATIVE_STARTUP_DIAGNOSTIC_PREFIX, appServerLaunchContext, createAppServerStartupDiagnostic } from './app-server-startup-diagnostic.mjs';
import { normalizeServer, launchSpec, serverLaunchOrigin } from './server-config.js';
import { WorkspaceAppServerBroker } from './workspace-app-server-broker.js';

const defaults = { platform: 'win32', appServerBin: 'C:\\Installed Current\\kcoder.exe', workspace: 'C:\\Owned Workspace', repoRoot: 'C:\\Owned Repo' };
function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const sent = []; let closed = 0;
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'owned', maxMessageBytes: 1024 * 1024,
    adapter: { rawPassthrough: true, fromUpstream: value => ({ upstream: [], client: [value] }) } });
  const client = { send: value => sent.push(value), close: () => { closed++; } };
  broker.clients.add(client);
  return { child, broker, sent, closed: () => closed };
}

test('explicit old executable/settings/profile provenance is preserved instead of silently choosing a second installation', () => {
  const target = normalizeServer({ id: 'owned-explicit', label: 'Owned explicit', transport: 'local',
    command: 'C:\\Installed Previous\\kcoder.exe', settingsFile: 'C:\\Owned Config\\settings.toml', profile: 'original-provider' }, defaults);
  const before = structuredClone(target);
  const launch = launchSpec(target, { platform: 'win32' });
  assert.equal(launch.command, before.command);
  assert.deepEqual(launch.args, ['--settings-file', before.settingsFile, '--profile', 'original-provider', 'app-server']);
  assert.deepEqual(target, before);
  const provenance = appServerLaunchContext(target, { commandSource: serverLaunchOrigin(target) });
  assert.deepEqual(provenance, { transport: 'local', commandSource: 'target_explicit', settingsSource: 'explicit_overlay',
    command: before.command, settingsFile: before.settingsFile, profile: 'original-provider' });
  const generated = normalizeServer({ id: 'local', label: 'Local', transport: 'local' }, defaults);
  assert.equal(serverLaunchOrigin(generated), 'gateway_default');
  assert.equal(serverLaunchOrigin({ ...generated, managed: true }), 'unknown', 'public fields cannot manufacture launch provenance');
});

test('only a closed typed diagnostic survives stderr chunking and no raw value is retained or interpreted', () => {
  const diagnostics = createAppServerStartupDiagnostic();
  diagnostics.write('api_key=owned-secret-1\nProvider panic context_window_tokens\n');
  assert.equal(diagnostics.failure({ code: 1 }).code, 'native_startup_failed', 'legacy text is not guessed into an authoritative reason');
  const marker = NATIVE_STARTUP_DIAGNOSTIC_PREFIX + JSON.stringify({ version: 1, code: 'settings_parse_failed', phase: 'initialize' }) + '\n';
  diagnostics.write(marker.slice(0, 14)); diagnostics.write(marker.slice(14));
  diagnostics.write(NATIVE_STARTUP_DIAGNOSTIC_PREFIX + JSON.stringify({ version: 1, code: 'provider_unconfigured', phase: 'initialize', token: 'owned-secret-2' }) + '\n');
  const failure = diagnostics.failure({ code: 1, signal: null });
  assert.deepEqual(failure, { version: 1, code: 'settings_parse_failed', phase: 'initialize', exitCode: 1 });
  assert.doesNotMatch(JSON.stringify(failure), /owned-secret|context_window_tokens|api_key/);
  assert.equal(nativeStartupDiagnostic({ version: 1, code: 'attacker-selected', phase: 'initialize' }), null);
});

test('oversized and partial untrusted stderr never turns into a startup diagnostic or copied log body', () => {
  const diagnostics = createAppServerStartupDiagnostic();
  diagnostics.write('x'.repeat(128 * 1024));
  diagnostics.write(NATIVE_STARTUP_DIAGNOSTIC_PREFIX + '{"version":1,"code":"model_limits_missing","phase":"initialize"}\n');
  assert.equal(diagnostics.failure({ code: 1 }).code, 'native_startup_failed');
  diagnostics.write(NATIVE_STARTUP_DIAGNOSTIC_PREFIX + '{"version":1,"code":"config_private_access","phase":"launch"}\n');
  assert.equal(diagnostics.failure({ code: 1 }).code, 'config_private_access');
  assert.equal(diagnostics.failure({ error: { code: 'ENOENT', message: 'owned-secret' } }).code, 'launcher_unavailable');
});

test('a real broker exit preserves the safe startup reason before closing and cannot leak Native stderr', () => {
  const f = fixture();
  f.child.stderr.write('SECRET_MUST_NOT_ENTER_GATEWAY_OR_UI\n');
  f.child.stderr.write(NATIVE_STARTUP_DIAGNOSTIC_PREFIX + '{"version":1,"code":"settings_overlay_unavailable","phase":"initialize"}\n');
  f.child.emit('close', 1, null);
  assert.equal(f.sent[0].method, 'server/disconnected');
  assert.equal(f.sent[0].params.startupDiagnostic.code, 'settings_overlay_unavailable');
  assert.doesNotMatch(JSON.stringify(f.sent) + f.broker.stderr, /SECRET_MUST_NOT/);
  assert.equal(f.closed(), 1); assert.equal(f.broker.closed, true);
  f.child.emit('close', 1, null); assert.equal(f.closed(), 1);
});

test('a successfully initialized runtime retains ordinary disconnect semantics', () => {
  const f = fixture(); f.broker.initializeResponse = { result: { serverInfo: { version: 'owned-version' } } };
  f.child.emit('close', 0, null);
  assert.deepEqual(f.sent[0].params, { serverId: 'owned', code: 0, signal: null });
  assert.equal(f.closed(), 1);
});
