import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { openRpc } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'desktop-auth-renewal-and-expiry-recovery', tier: 'full-integration',
  modelPolicy: 'Real isolated Electron/Gateway session lifetime and navigation; no model calls',
}, async context => {
  assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1');
  const xvfb = await requireExecutable('/usr/bin/xvfb-run', 'Xvfb');
  const electron = await requireExecutable(resolve(appRoot, 'node_modules/electron/dist/electron'), 'Electron');
  const binary = await requireExecutable(resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'session-renewal' });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {});
  const serversFile = await context.writeStateJson('servers.jsonc', [
    { id: 'local', label: 'Renewal fixture', transport: 'local', command: binary, workspace: workspace.path },
  ]);
  const child = context.spawnOwned('renewal-electron', xvfb,
    ['-a', electron, '--no-sandbox', '--disable-gpu', '--inspect=127.0.0.1:0',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', resolve(appRoot, 'desktop/main.mjs')],
    { cwd: appRoot, env: context.isolatedEnvironment({
      KCODER_CONFIG_DIR: profile, KCODER_STUDIO_SERVERS_FILE: serversFile,
      KCODER_STUDIO_WORKSPACE: workspace.path, KCODER_STUDIO_KCODER_BIN: binary,
      KCODER_STUDIO_WEB_ROOT: resolve(appRoot, 'renderer/dist'),
      KCODER_STUDIO_AUTH_SESSION_TTL_MS: '2000',
      KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState('electron-profile'),
    }) });
  let output = '';
  const collect = chunk => { output = (output + chunk).slice(-16000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const address = await waitFor(() => output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],
    30000, 'desktop CDP', 100, context.abortSignal);
  const browser = await chromium.connectOverCDP(address);
  context.registerPort('renewal-desktop-cdp', Number(new URL(address).port));
  context.addCleanup('close desktop CDP', () => browser.close());
  const page = await waitFor(() => browser.contexts().flatMap(value => value.pages()).find(value => value.url().startsWith('http://127.0.0.1:')),
    30000, 'desktop page', 100, context.abortSignal);
  const origin = new URL(page.url()).origin;
  const inspectorAddress = output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
  assert.ok(inspectorAddress);
  context.registerPort('renewal-main-inspector', Number(new URL(inspectorAddress).port));
  const inspector = await openRpc(inspectorAddress);
  context.addCleanup('close main inspector', () => inspector.close());
  let sequence = 0;
  const evaluateMain = async params => {
    const id = ++sequence;
    inspector.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params }));
    const response = await inspector.waitFor(message => message.id === id, 10000, 'desktop main evaluation');
    assert.ok(!response.error && !response.result?.exceptionDetails, 'desktop main evaluation must succeed');
    return response.result;
  };
  const cookie = async () => {
    const result = await evaluateMain({
      expression: "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').session.fromPartition('persist:kcoder-studio-desktop').cookies.get({ name: 'kcoder_studio_session' })",
      awaitPromise: true, returnByValue: true,
    });
    assert.ok(!result.exceptionDetails, 'desktop cookie inspection must succeed');
    const item = result.result.value?.[0];
    assert.ok(item); context.registerSecret(item.value); return item.value;
  };
  const first = await cookie();
  await new Promise(resolve => setTimeout(resolve, 6500));
  assert.equal(await cookie(), first, 'renewal must preserve the live session identity');
  assert.equal(await page.evaluate(async () => (await fetch('/api/servers')).status), 200);
  // Keep the Gateway running while desktop timers cannot execute, as during a delayed wake-up.
  await evaluateMain({
    expression: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3200)', returnByValue: true,
  });
  await waitFor(async () => await cookie() !== first, 15000, 'expired desktop session recovery', 100, context.abortSignal);
  await page.goto(origin + '/login?returnTo=%2Fplugins%2Fmanage').catch(error => {
    if (!String(error).includes('ERR_ABORTED')) throw error;
  });
  await page.waitForURL(url => url.pathname === '/plugins/manage', { timeout: 15000 });
  assert.equal(await page.evaluate(async () => (await fetch('/api/servers')).status), 200);
  await context.writeArtifactJson('renewal-result.json', {
    proactiveRenewalPreservesIdentity: true, expiredSessionRecovered: true,
    loginPageRestoredRoute: true,
  });
});
