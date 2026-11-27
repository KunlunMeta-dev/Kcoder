import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';

const confirmed = Buffer.from('kcoder-owned-cleanup/v1\nconfirmed\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function catalogFor(profile, id) {
  const entries = await readdir(profile, { withFileTypes: true });
  assert.ok(entries.length <= 256);
  const matches = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('integration-') || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const catalog = join(profile, entry.name, 'catalog');
    try {
      const file = join(catalog, 'profiles.json'), stat = await lstat(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 512 * 1024);
      const state = JSON.parse(await readFile(file, 'utf8'));
      if (state.profiles?.[id]?.draft?.id === id) matches.push({ catalog, state });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(matches.length, 1, 'observe the exact profile created by this fixture');
  return matches[0];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  runWindowsBrowserProfileCrash({ root, binary: join(root, 'probe-cli.exe'),
    supervisor: join(root, 'probe-supervisor.exe'), chromium: join(root, 'chromium', 'chrome-win64', 'chrome.exe') })
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; });
}

/** Called inside the existing ordinary-account/private-desktop owner Job. */
export async function runWindowsBrowserProfileCrash({ root, binary, supervisor, chromium }) {
  assert.equal(process.platform, 'win32');
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'USERPROFILE', 'HOME',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  environment.KCODER_CHROMIUM_BIN = chromium;
  environment.KCODER_PROCESS_SUPERVISOR_BIN = supervisor;
  const profile = join(environment.USERPROFILE, '.config', 'kcoder');
  await assert.rejects(lstat(profile), { code: 'ENOENT' });
  await mkdir(profile, { recursive: true });
  const workspace = join(root, 'browser-crash-workspace');
  await mkdir(workspace);
  const providerRequests = [];
  const site = createServer((request, response) => {
    if (request.url.startsWith('/v1/')) {
      assert.ok(providerRequests.length < 16);
      providerRequests.push({ method: request.method, path: request.url.split('?')[0] });
      response.writeHead(503); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Owned browser recovery</title><p>Independent account</p>');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;
  await writeFile(join(profile, 'settings.json'), JSON.stringify({
    credential_store: 'file', mcp_servers: [], hooks: {}, active_provider: 'fixture',
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: url + 'v1', default_model: 'fixture', discover_models: false,
      context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 2048 } },
  }), { flag: 'wx' });
  const owners = [];
  const open = () => {
    // The enclosing original private desktop Job owns every child and helper.
    const child = spawn(binary, ['--settings-file', join(profile, 'settings.json'), '--cwd', workspace, 'app-server'],
      { cwd: workspace, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new AppServerStdioClient('browser-crash-' + owners.length, child);
    let stderr = '';
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
    const owner = { child, client, stderr: () => stderr }; owners.push(owner); return owner;
  };
  const call = async (owner, method, params) => {
    const response = await owner.client.request(method, params);
    assert.equal(response.error, undefined, `native ${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const initialize = async owner => {
    const response = await call(owner, 'initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'ordinary-browser-crash-owner', version: '1' },
      capabilities: { experimental: { integrationScopeV1: true, browserProfilesV1: true, browserProfileSessionsV1: true } } });
    assert.equal(response.capabilities.experimental.browserProfileSessionsV1, true);
    return call(owner, 'integrations/scope/read', {});
  };
  const start = (owner, scope, operationId) => call(owner, 'browser/start', {
    url, profile: { scope, profileId: 'owned-crash', expectedRevision: 1, operationId },
  });
  const cookie = (owner, session, expression) => call(owner, 'browser/evaluate', { session_id: session.session_id, expression });
  try {
    const original = open(), scope = await initialize(original);
    const saved = await call(original, 'integrations/browserProfiles/save', {
      contractVersion: 'parallel-v1', requestId: 'save-owned-crash', operationId: 'create-owned-crash',
      scope, timeoutMs: 1000, payload: { draft: { id: 'owned-crash', label: 'Owned crash profile', purpose: 'business' }, expectedRevision: 0 },
    });
    assert.equal(saved.status, 'completed');
    const first = await start(original, scope, 'normal-cookie-close');
    await cookie(original, first, "document.cookie='account=owned; Max-Age=3600; Path=/'; document.cookie");
    assert.equal((await call(original, 'browser/close', { session_id: first.session_id })).closed, true);
    const running = await start(original, scope, 'original-before-host-crash');
    assert.equal((await cookie(original, running, 'document.cookie')).value, 'account=owned');
    const observed = await catalogFor(profile, 'owned-crash');
    const useId = observed.state.activeUses['owned-crash'].useId;
    assert.equal(observed.state.useOperations['original-before-host-crash'].useId, useId);
    const receipt = join(observed.catalog, `cleanup-${useId}.receipt`);
    assert.equal((await readFile(receipt)).length, 0);
    assert.equal(original.child.kill('SIGKILL'), true, 'kill only the original app-server child');
    await waitForStdioChildClose(original.child, 10000, 'original app-server hard crash');
    const deadline = Date.now() + 10000;
    while (!(await readFile(receipt)).equals(confirmed)) {
      assert.ok(Date.now() < deadline, 'the original cleanup owner must confirm; absence cannot release use');
      await sleep(10);
    }
    const reopened = open(), current = await initialize(reopened);
    assert.deepEqual(current, scope);
    const recovered = await start(reopened, current, 'explicit-user-after-confirmed-cleanup');
    assert.equal((await cookie(reopened, recovered, 'document.cookie')).value, 'account=owned');
    const replay = await reopened.client.request('browser/start', {
      url, profile: { scope: current, profileId: 'owned-crash', expectedRevision: 1, operationId: 'original-before-host-crash' },
    });
    assert.ok(replay.error, 'the original launch ID must never replay after restart');
    assert.equal((await call(reopened, 'browser/close', { session_id: recovered.session_id })).closed, true);
    await writeFile(join(root, 'native-components-progress.json'), JSON.stringify({
      originalReceiptConfirmed: true, originalLaunchReplayRejected: true,
      normalCookieCloseReopen: true, cookieRetainedAfterRecovery: true, providerRequests,
    }));
    const providerCalls = providerRequests.filter(request => !['GET', 'HEAD'].includes(request.method)).length;
    assert.equal(providerCalls, 0, 'no model-producing HTTP request');
    return { passed: true, defaultProductionProfile: true, profilePathChars: profile.length,
      userDataPathChars: join(observed.catalog, 'browser-data-owned-crash').length,
      chromiumDefaultKeyPolicy: true, passwordStoreOverride: false,
      normalCookieCloseReopen: true, actualAppServerHardCrash: true, originalReceiptConfirmed: true,
      originalLaunchReplayRejected: true, cookieRetainedAfterRecovery: true, providerCalls,
      providerMetadataRequests: providerRequests, modelCalls: 0, studioUi: false, gatewayOuterJob: false };
  } finally {
    for (const owner of owners.reverse()) {
      if (owner.child.exitCode === null && owner.child.signalCode === null) {
        owner.child.stdin.end();
        try { await waitForStdioChildClose(owner.child, 10000, 'owned browser app-server cleanup'); }
        catch { owner.child.kill(); await waitForStdioChildClose(owner.child, 10000, 'owned browser app-server forced cleanup'); }
      }
      owner.client.closeReader();
    }
    await writeFile(join(root, 'native-components-last-stderr.log'),
      owners.map((owner, index) => `original-owner-${index}:\n${owner.stderr()}`).join('\n'));
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
  }
}
