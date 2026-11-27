import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PassThrough } from 'node:stream';
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { RunContext } from './run-context.mjs';
import { officeBudget, officeBudgetMeter } from './kworker-office-budget.mjs';
import { planRetention } from './retention.mjs';
import { copyVerifiedSnapshot } from './frozen-copy.mjs';
import { startActivationMcp } from './activation-mcp.mjs';
import { verifyPinnedGatewayInventories } from './pinned-gateway.mjs';
import { assertRendererBuildFresh } from './renderer-build.mjs';
import { resolveDesktopPort } from '../../desktop/desktop-port.mjs';
import { windowsMemorySnapshotSelection } from './windows-memory-snapshot-cases.mjs';
import { createPhysicalControllerClient } from './physical-web-windows.mjs';
import { acceptPendingNativeApproval } from './windows-native-web-search.mjs';
import { closeCrossHostResources, ownedCrossHostProcessRanges } from './windows-cross-host-source-case.mjs';
import { finishSmallAssetCleanup } from './migration-small-assets.mjs';
import { waitForStdioChildClose } from './app-server-stdio.mjs';
import { resolveRealModelConfigDirectory, selectWorkflowModel } from './real-model.mjs';
import { isolatedGatewayAuthority } from '../../../kcoder-relay/src/gateway-origin.mjs';
import { startHttpsGatewayProxy } from './https-gateway-proxy.mjs';
import { openWorkflowTaskCreator, openWikiSharedKnowledge } from './automation-navigation.mjs';
import { waitForWidgetSandboxFrame } from './widgets-rendering.mjs';
import { awaitOwnedDesktopActor } from './windows-desktop-action-entry.cjs';
import { startOctopReference } from './octop-reference.mjs';
import { collectWindowsInstallerDiagnostics } from './windows-installer-lifecycle.mjs';
import { startNativeCodeManager } from './native-code-service.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashJson = value => sha(Buffer.from(JSON.stringify(value)));
async function owned(t, operation) {
  const context = await RunContext.create(import.meta.url, { testId: t.name });
  let failure;
  try { return await operation(context); }
  catch (error) { failure = error; throw error; }
  finally {
    try { await context.finish(failure ? 'failed' : 'passed', { offline: true }); }
    catch (error) { if (!failure) throw error; }
  }
}

test('office request budget rejects poisoned metadata before reserving cost', () => {
  const budget = officeBudget({ KCODER_E2E_OFFICE_INPUT_USD_PER_MILLION: '1', KCODER_E2E_OFFICE_OUTPUT_USD_PER_MILLION: '1' });
  const meter = officeBudgetMeter(budget, 'fixture', () => 0);
  meter.beginCase('case');
  for (const bodyBytes of [undefined, NaN, -1, '100', Infinity, 0.5]) {
    assert.throws(() => meter.admit({ model: 'fixture', bodyBytes, outputTokenLimit: 512 }), /budget mismatch/);
    assert.equal(meter.snapshot().requests, 0);
    assert.equal(meter.snapshot().reservedEstimatedUsd, 0);
  }
  assert.throws(() => meter.admit(null), /budget mismatch/);
  assert.equal(meter.admit({ model: 'fixture', bodyBytes: 100, outputTokenLimit: 512 }).requestNumber, 1);
  assert.ok(Number.isFinite(meter.snapshot().reservedEstimatedUsd));
});

test('retention count overrides reject invalid deletion settings', () => {
  const now = Date.now();
  const runs = Array.from({ length: 4 }, (_, index) => ({ path: `/owned-${index}`, source: 'fixture', status: 'passed', endedAtMs: now - index, sizeBytes: 1 }));
  assert.deepEqual(planRetention(runs, { maxRunsPerVariant: 3 }).map(row => row.path), ['/owned-3']);
  for (const policy of [null, [], { maxRunsPerVariant: undefined }, { maxRunsPerVariant: NaN }, { maxRunsPerVariant: -1 }, { unknown: 1 }]) {
    assert.throws(() => planRetention(runs, policy), /Invalid retention policy/);
  }
});

test('frozen copy rejects overlapping roots before any removal and preserves a valid sibling copy', { timeout: 15_000 }, t => owned(t, async context => {
  const source = context.pathInState('snapshot'); await mkdir(source);
  await writeFile(join(source, 'sentinel.txt'), 'owned snapshot');
  for (const destination of [source, context.stateDir, join(source, 'nested'), '']) {
    await assert.rejects(copyVerifiedSnapshot({ sourceRoot: source, destination }), /overlap|explicit nonempty/);
    assert.equal(await readFile(join(source, 'sentinel.txt'), 'utf8'), 'owned snapshot');
  }
  await writeFile(join(source, 'freeze.json'), JSON.stringify({ sourceDigest: 'fixture', count: 1 }));
  await writeFile(join(source, 'sha256.json'), JSON.stringify({ 'sentinel.txt': sha('owned snapshot') }));
  const destination = context.pathInState('copied');
  await copyVerifiedSnapshot({ sourceRoot: source, destination, expectedDigest: 'fixture', expectedCount: 1 });
  assert.equal(await readFile(join(destination, 'sentinel.txt'), 'utf8'), 'owned snapshot');
}));

test('activation MCP handles malformed and non-POST requests without losing its listener', { timeout: 15_000 }, t => owned(t, async context => {
  const root = await startActivationMcp(context);
  assert.equal((await fetch(root + '/zero')).status, 405);
  for (const body of ['', '{', 'null', '[]']) {
    assert.equal((await fetch(root + '/zero', { method: 'POST', body })).status, 400);
  }
  assert.equal((await fetch(root + '/zero', { method: 'POST', body: '{}' })).status, 202);
  const response = await fetch(root + '/zero', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 1);
}));

test('held Gateway manifest is rechecked against current source and dependency bytes at load', { timeout: 15_000 }, t => owned(t, async context => {
  const root = context.pathInState('gateway'); const dependencies = join(root, 'node_modules');
  await mkdir(dependencies, { recursive: true });
  await writeFile(join(root, 'server.mjs'), 'original source');
  await writeFile(join(dependencies, 'package.js'), 'original dependency');
  const sourceFiles = [{ path: 'server.mjs', size: 15, sha256: sha('original source') }];
  const dependencyFiles = [{ path: 'package.js', size: 19, sha256: sha('original dependency') }];
  const manifest = { sourceFiles, dependencyFiles, sourceTreeSha256: hashJson(sourceFiles), dependencyTreeSha256: hashJson(dependencyFiles) };
  await verifyPinnedGatewayInventories(root, manifest);
  await writeFile(join(root, 'server.mjs'), 'changed source');
  await assert.rejects(verifyPinnedGatewayInventories(root, manifest), /source tree differs/);
  await writeFile(join(root, 'server.mjs'), 'original source');
  await writeFile(join(dependencies, 'package.js'), 'changed dependency');
  await assert.rejects(verifyPinnedGatewayInventories(root, manifest), /dependency tree differs/);
}));

test('renderer freshness rejects missing mandatory roots instead of comparing zero timestamps', { timeout: 15_000 }, t => owned(t, async context => {
  await assert.rejects(assertRendererBuildFresh({ sourceRoot: context.pathInState('missing-source'), buildRoot: context.pathInState('missing-build') }), { code: 'ENOENT' });
}));

test('desktop port recovers a truncated receipt and publishes a complete replacement', { timeout: 15_000 }, t => owned(t, async context => {
  const userDataDir = context.pathInState('desktop-profile'); await mkdir(userDataDir);
  await writeFile(join(userDataDir, 'gateway-port'), '');
  const port = await resolveDesktopPort({ userDataDir });
  assert.ok(Number.isInteger(port) && port >= 42_000 && port < 55_000);
  assert.equal(await readFile(join(userDataDir, 'gateway-port'), 'utf8'), `${port}\n`);
  assert.deepEqual(await readdir(userDataDir), ['gateway-port']);
  assert.equal(await resolveDesktopPort({ userDataDir }), port);
}));

test('State snapshot native roster matches every current test in the selected Rust module', async () => {
  const source = await readFile(new URL('../../../../crates/kcoder_state/src/imported_context_snapshot/tests.rs', import.meta.url), 'utf8');
  const names = [...source.matchAll(/#\[test\]\s*fn\s+(\w+)\s*\(/g)].map(match => match[1]).sort();
  const selection = windowsMemorySnapshotSelection();
  assert.deepEqual(selection.expectedTests.map(name => name.slice(selection.testFilter.length)).sort(), names);
});

test('Gateway load refuses contained dependency directory cycles', { timeout: 15_000, skip: process.platform === 'win32' }, t => owned(t, async context => {
  const root = context.pathInState('gateway-cycle'); const dependencies = join(root, 'node_modules');
  await mkdir(dependencies, { recursive: true }); await symlink('.', join(dependencies, 'loop'));
  await assert.rejects(verifyPinnedGatewayInventories(root, { sourceFiles: [], dependencyFiles: [] }), /directory cycle/);
}));

test('physical controller immediately settles pending requests on transport loss', async () => {
  const makeChild = () => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
  });
  for (const kind of ['close', 'pipe', 'malformed']) {
    const child = makeChild(), controller = createPhysicalControllerClient(child, 'synthetic-owner', { timeoutMs: 1000 });
    const pending = controller.request('observe');
    if (kind === 'close') { child.exitCode = 1; child.emit('close', 1); }
    if (kind === 'pipe') child.stdin.emit('error', new Error('synthetic pipe failure'));
    if (kind === 'malformed') child.stdout.write('not-json\n');
    await assert.rejects(pending, /Owned controller/);
    await assert.rejects(controller.request('observe'), /Owned controller/);
    controller.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
  const child = makeChild(), controller = createPhysicalControllerClient(child, 'synthetic-owner');
  child.stdout.write('{"ready":true}\n'); assert.equal(controller.ready.ready, true);
  const pending = controller.request('observe'), frame = JSON.parse(child.stdin.read().toString());
  child.stdout.write(JSON.stringify({ id: frame.id, result: { observed: true } }) + '\n');
  assert.deepEqual(await pending, { observed: true });
  controller.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});

test('native approval pump skips unrelated server requests without authorizing them', async () => {
  const rpc = { pendingServerRequests: () => [{ id: 1, method: 'unrelated/request', params: {} }] };
  assert.equal(await acceptPendingNativeApproval(rpc, 'thread', 'turn'), null);
});

test('PowerShell process diagnostics serialize only verified numeric process ranges', () => {
  assert.deepEqual(ownedCrossHostProcessRanges([{ event: 'spawn', pid: 10, at: 20 }, { event: 'exit', pid: 10, at: 30 }], 40), ['@{Pid=10;Start=20;End=30}']);
  for (const at of ['20;throw 1', null, -1, NaN]) {
    assert.throws(() => ownedCrossHostProcessRanges([{ event: 'spawn', pid: 10, at }], 40), /Invalid owned process/);
  }
});

test('failed migration diagnostics cannot prevent remaining owned cleanup or hide the original failure', async () => {
  const original = new Error('original fixture failure'), visited = [];
  await assert.rejects(finishSmallAssetCleanup([
    () => { visited.push('freeze'); throw new Error('diagnostic failure'); },
    async () => { visited.push('rpc'); },
    () => { visited.push('browser'); throw new Error('browser cleanup failure'); },
    () => { visited.push('gateway'); },
  ], original), error => error instanceof AggregateError && error.errors[0] === original && error.errors.length === 3);
  assert.deepEqual(visited, ['freeze', 'rpc', 'browser', 'gateway']);
});

test('canonical fixture roots survive a symlinked TMPDIR without weakening readers', { timeout: 15_000, skip: process.platform === 'win32' }, t => owned(t, async context => {
  const actual = context.pathInState('actual-tmp'), alias = context.pathInState('alias-tmp');
  await mkdir(actual); await symlink(actual, alias, 'dir');
  const source = name => fileURLToPath(new URL(name, import.meta.url));
  const child = context.spawnOwned('canonical-fixture-alias', process.execPath, ['--test',
    source('./migration-renderer-baseline.test.mjs'), source('./run-context-recovery.test.mjs'), source('../../desktop/packaged-native-integrity.test.mjs')],
  { env: context.isolatedEnvironment({ TMPDIR: alias, TMP: alias, TEMP: alias }) });
  assert.equal((await waitForStdioChildClose(child, 10_000, 'canonical fixture alias')).code, 0);
}));

test('model config selection honors explicit profile precedence without reading credential files', () => {
  const cwd = process.cwd();
  assert.equal(resolveRealModelConfigDirectory({ KCODER_CONFIG_DIR: 'chosen', KCODER_HOME: 'ignored' }, 'kcoder-dev', cwd), join(cwd, 'chosen'));
  assert.equal(resolveRealModelConfigDirectory({ KCODER_HOME: 'profile' }, 'kcoder-dev', cwd), join(cwd, 'profile'));
  assert.equal(resolveRealModelConfigDirectory({ HOME: cwd, USERPROFILE: cwd }, 'kcoder-dev'), join(cwd, '.config', 'kcoder-dev'));
});

test('protocol comparison supports declared env-only keys and does not expose malformed store bytes', { timeout: 15_000 }, t => owned(t, async context => {
  const configDir = context.pathInState('comparison'); await mkdir(configDir);
  const model = { provider: 'fixture', credentialEnv: ['OWNED_KEY'], configDir, providerConfig: { api_format: 'anthropic_messages', endpoint: 'https://example.invalid/v1' } };
  const key = 'SYNTHETIC_ENV_ONLY_COMPARISON_KEY';
  const selected = await selectWorkflowModel(context, model, { OWNED_KEY: key, KCODER_E2E_WORKFLOW_PROTOCOL: 'openai_chat_completions' });
  assert.equal(selected.credentialEnv.KCODER_E2E_WORKFLOW_COMPARISON_KEY, key);
  assert.equal(context.redactValue(key), '[REDACTED]');
  const privateMarker = 'SYNTHETIC_PRIVATE_CREDENTIAL';
  await writeFile(join(configDir, 'credentials.json'), '{' + privateMarker);
  await assert.rejects(selectWorkflowModel(context, model, { KCODER_E2E_WORKFLOW_PROTOCOL: 'openai_chat_completions' }), error =>
    error.message.startsWith('UNMET_PREREQUISITE:') && !error.message.includes(privateMarker) && !error.cause);
}));

test('HTTPS fixture rejects backslash upstream switches and survives truncated upstream bodies', { timeout: 15_000, skip: process.platform === 'win32' }, t => owned(t, async context => {
  let foreignRequests = 0;
  async function server(label, handler) {
    const instance = createHttpServer(handler);
    context.addCleanup(`close ${label}`, async () => { instance.closeAllConnections(); if (instance.listening) await new Promise(resolve => instance.close(resolve)); });
    await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
    context.registerPort(label, instance.address().port); return instance;
  }
  const target = await server('allowed-upstream', (request, response) => {
    if (request.url === '/cut') { response.writeHead(200, { 'content-length': '100' }); response.write('partial'); setImmediate(() => response.destroy()); }
    else response.end('owned');
  });
  const foreign = await server('foreign-owned-upstream', (_request, response) => { foreignRequests++; response.end('wrong upstream'); });
  const proxy = await startHttpsGatewayProxy(context);
  proxy.setTarget(`http://127.0.0.1:${target.address().port}`);
  const exchange = path => new Promise((resolve, reject) => {
    const request = httpsRequest(proxy.origin, { path, rejectUnauthorized: false }, response => {
      response.resume(); response.once('error', reject); response.once('end', () => resolve(response.statusCode));
    });
    request.setTimeout(3000, () => request.destroy(new Error('owned HTTPS exchange deadline')));
    request.once('error', reject); request.end();
  });
  assert.equal(await exchange(`/\\127.0.0.1:${foreign.address().port}/blocked`), 400);
  assert.equal(foreignRequests, 0);
  await assert.rejects(exchange('/cut'));
  assert.equal(await exchange('/ok'), 200);
}));

test('legacy subscription/publication navigation reports unsupported current surfaces before timing out', async () => {
  function pageFor(ids) {
    const clicks = [];
    return { clicks, getByTestId: id => ({ count: async () => ids.has(id) ? 1 : 0, isVisible: async () => ids.has(id),
      click: async () => { clicks.push(id); }, selectOption: async () => {}, waitFor: async () => {},
      getAttribute: async () => 'true', evaluate: async () => false }) };
  }
  const current = pageFor(new Set(['automations-button', 'automation-tab-settings', 'scheduled-task-kind', 'scheduled-workflow-tasks']));
  await assert.rejects(openWorkflowTaskCreator(current), /UNMET_PREREQUISITE:.*advanced workflow subscription creator/);
  assert.deepEqual(current.clicks, ['automations-button', 'automation-tab-settings']);
  const memoryOnly = pageFor(new Set(['knowledge-button', 'wiki-workspace-tab-memory']));
  await assert.rejects(openWikiSharedKnowledge(memoryOnly), /UNMET_PREREQUISITE:.*knowledge publications/);
  assert.deepEqual(memoryOnly.clicks, ['knowledge-button', 'wiki-workspace-tab-memory']);
  const supported = pageFor(new Set(['knowledge-button', 'wiki-workspace-tab-memory', 'knowledge-publications']));
  await openWikiSharedKnowledge(supported);
});

test('widget rendering waits for the exact frame navigation when only contentWindow exists', async () => {
  const frame = { url: () => 'http://owned/sandbox' };
  assert.equal(await waitForWidgetSandboxFrame({ frames: () => [frame], waitForEvent: () => { throw new Error('unexpected wait'); } }, frame.url()), frame);
  assert.equal(await waitForWidgetSandboxFrame({ frames: () => [], waitForEvent: async (event, options) => {
    assert.equal(event, 'framenavigated'); assert.equal(options.timeout, 10000);
    assert.equal(options.predicate({ url: () => 'about:blank' }), false); assert.equal(options.predicate(frame), true);
    return frame;
  } }, frame.url()), frame);
});

test('cross-host cleanup closes its model after failed Gateway termination and preserves the primary failure', async () => {
  let killed = 0, disconnected = 0, closed = 0;
  const original = new Error('original cross-host failure');
  await assert.rejects(closeCrossHostResources({
    gateway: { exitCode: null, signalCode: null, kill() { killed++; } },
    model: { closeAllConnections() { disconnected++; }, close(callback) { closed++; callback(); } },
    primaryFailure: original, waitForExit: async (_condition, _label, deadline) => { assert.equal(deadline, 5000); throw new Error('controlled exit timeout'); },
  }), error => error instanceof AggregateError && error.errors[0] === original);
  assert.equal(killed, 1); assert.equal(disconnected, 1); assert.equal(closed, 1);
});

test('desktop supervisor READY failure revokes its own lease and drains the exact helper', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  let revoked = 0, killed = 0;
  child.stdin = { destroy() { revoked++; } };
  child.kill = () => { killed++; child.signalCode = 'SIGTERM'; child.emit('close', null, 'SIGTERM'); };
  const original = new Error('controlled READY failure');
  await assert.rejects(awaitOwnedDesktopActor(child, { readyPromise: Promise.reject(original) }, { exitTimeoutMs: 5 }), error => error === original);
  assert.equal(revoked, 1); assert.equal(killed, 1);
});

test('reference setup refuses a cleanup budget that cannot contain its owned remote teardown', async () => {
  await assert.rejects(startOctopReference({ metadata: { cleanupTimeoutMs: 10000 } }), /UNMET_PREREQUISITE:.*cleanup budget/);
});

test('installer diagnostics have their own short deadline and cannot replace a primary failure', async () => {
  let probes = 0, recorded, clock = 0;
  const report = await collectWindowsInstallerDiagnostics({ pathInArtifacts: name => name, writeArtifactJson: async (_name, value) => { recorded = value; } }, {
    target: 'owned', remote: 'owned-root', directory: 'D:\\owned', nativeComponents: true, primaryFailed: true, timeoutMs: 20, now: () => clock,
    ps: async (_script, _input, budget) => { probes++; clock = 20; assert.ok(budget <= 20); return new Promise(() => {}); },
    execute: async () => { throw new Error('unexpected copy'); },
  });
  assert.equal(probes, 1); assert.equal(report.complete, false); assert.equal(report.primaryFailed, true);
  assert.equal(recorded, report); assert.ok(report.failures.some(value => value.reason === 'budget_exhausted'));
});

test('installer diagnostic selection retains the intended JSON, PNG and Office artifact names', async () => {
  const names = ['seed-stdout.json', 'windows-approval.png', 'claimed-native-office.docx'], copied = [];
  const report = await collectWindowsInstallerDiagnostics({ pathInArtifacts: value => value, writeArtifactJson: async () => {} }, {
    target: 'owned', remote: 'owned-root', directory: 'D:\\owned', exerciseUI: true,
    ps: async script => {
      if (!script.includes('Get-ChildItem')) return 'False';
      const pattern = /-match '([^']+)'/.exec(script)?.[1]; assert.ok(pattern);
      return JSON.stringify(names.filter(value => new RegExp(pattern).test(value)));
    }, execute: async (_command, args) => { copied.push(args.at(-1)); },
  });
  assert.equal(report.complete, true); assert.deepEqual(copied, names); assert.equal(report.copied, 3);
});

test('installer diagnostics retain the UI failure before slower optional step probes exhaust the budget', async () => {
  let clock = 0;
  const copied = [];
  const report = await collectWindowsInstallerDiagnostics({ pathInArtifacts: value => value, writeArtifactJson: async () => {} }, {
    target: 'owned', remote: 'owned-root', directory: 'D:\\owned', exerciseUI: true, primaryFailed: true,
    timeoutMs: 20, now: () => clock,
    ps: async script => {
      if (script.includes('Get-ChildItem')) return JSON.stringify(['seed-stdout.json', 'windows-model-settings-observation.json']);
      clock = 20;
      return 'False';
    },
    execute: async (_command, args) => { copied.push(args.at(-1)); },
  });
  assert.deepEqual(copied, ['seed-stdout.json', 'windows-model-settings-observation.json']);
  assert.equal(report.primaryFailed, true);
  assert.ok(report.failures.some(value => value.reason === 'budget_exhausted'));
});

test('unknown native manager startup retains its fixture fence and records the original owner evidence', async () => {
  let recorded;
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, pid: 123, stdout: new PassThrough(), stdin: new PassThrough() });
  const context = { processes: new Map(),
    spawnOwned() { this.processes.set('original-manager', { identity: { pid: 123, startTicks: '456' } }); queueMicrotask(() => { child.exitCode = 1; child.emit('close', 1); }); return child; },
    addCleanup() {},
    writeArtifactJsonInternal: async (_name, value) => { recorded = value; } };
  const fixture = { activeManagers: new Set(), binary: '/owned/kcoder', profile: '/owned/profile', workspace: '/owned/workspace', uid: 1234, gid: 1234, env: {}, imageSha256: 'a'.repeat(64) };
  await assert.rejects(startNativeCodeManager(context, fixture, 'original-manager'), error => error.nativeManagerStartup?.state === 'unknown_startup');
  assert.equal(fixture.activeManagers.has('original-manager'), true);
  assert.equal(recorded.completeWorkerAuthority, 'not_confirmed'); assert.equal(recorded.cleanupOwner, 'original_native_service_manager');
  assert.equal(recorded.managerStartTicks, '456'); assert.equal(recorded.retainFixtureAndProfile, true);
  child.stdout.destroy(); child.stdin.destroy();
});
