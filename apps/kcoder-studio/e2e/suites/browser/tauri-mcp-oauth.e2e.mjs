import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

// QA: real Tauri controls and notifications on an owned X display. The deny-all verification
// window cannot open external windows; follow the actual displayed authorization link over HTTP.
// Real browser navigation is separately covered by mcp-oauth-ui.e2e.mjs.
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('KCODER_E2E_TAURI_BIN is required');
await runE2E(import.meta.url, {
  testId: 'tauri-mcp-authorization-controls-and-callback',
  tier: 'manual-live',
  modelPolicy: 'model-independent real Tauri/Gateway/app-server plus owned OAuth HTTP fixture; native external opener excluded by deny-all harness',
}, async context => {
  const secret = randomBytes(24).toString('hex');
  context.registerSecret(secret);
  const fixture = await startOAuthMcpFixture(context, {
    manualClient: { id: 'tauri-manual-client', secret, method: 'client_secret_basic' },
  });
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const panel = '[data-testid="kcoder-mcp-management"]';
  const link = '[data-testid="kcoder-mcp-open-authorization"]';
  const text = () => client.command('getText', { selector: panel });
  const button = panel + ' [data-testid="kcoder-mcp-auth-action"]';
  const clickAction = async () => {
    await client.command('waitFor', { selector: button, enabled: true, timeoutMs: 15000 });
    await client.command('click', { selector: button });
  };
  const manualLogin = async () => {
    await client.command('waitFor', { selector: button, enabled: true, timeoutMs: 15000 });
    await client.command('click', { selector: panel + ' summary' });
    await client.command('fill', { selector: panel + ' form label:first-of-type input', value: 'tauri-manual-client' });
    await client.command('fill', { selector: panel + ' form select', value: 'client_secret_basic' });
    await client.command('fill', { selector: panel + ' form input[type="password"]', value: secret });
    await client.command('click', { selector: panel + ' form button[type="submit"]' });
  };
  try {
    const settings = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    settings.mcp_servers = [];
    await writeFile(client.settingsPath, JSON.stringify(settings), { mode: 0o600 });
    await client.command('navigate', { value: '/plugins/manage' });
    await client.command('waitFor', { selector: '[data-testid="kcoder-plugin-tab-mcp"]', visible: true, timeoutMs: 15000 });
    await waitFor(async () => (await client.command('getText', { selector: '[data-testid="plugins-install-target"]' })).includes('/workspaces/tauri-verification'),
      15000, 'Tauri selected target bootstrap', 100, context.abortSignal);
    await client.command('click', { selector: '[data-testid="kcoder-plugin-tab-mcp"]' });
    assert.equal(await client.command('getAttribute', { selector: '[data-testid="kcoder-plugin-tab-mcp"]', value: 'aria-selected' }), 'true');
    await client.command('click', { selector: panel + ' > div > button' });
    const installForm = '[data-testid="kcoder-mcp-install-form"]';
    await client.command('waitFor', { selector: installForm, visible: true, timeoutMs: 10000 });
    await client.command('fill', { selector: installForm + ' label:nth-of-type(1) input', value: 'Tauri OAuth MCP' });
    await client.command('fill', { selector: installForm + ' label:nth-of-type(3) input', value: fixture.root + '/mcp' });
    await client.command('click', { selector: installForm + ' button[type="submit"]' });
    await waitFor(async () => Number(await client.command('getElementCount', { selector: installForm })) === 0,
      15000, 'Tauri MCP configuration save', 100, context.abortSignal);
    assert.deepEqual(JSON.parse(await readFile(client.settingsPath, 'utf8')).providers, settings.providers);

    await client.command('waitFor', { selector: panel + ' article', visible: true, timeoutMs: 15000 });
    assert.match(await text(), /Tauri OAuth MCP/);
    await manualLogin();
    await client.command('waitFor', { selector: link, visible: true, timeoutMs: 15000 });
    const authorizationUrl = await client.command('getAttribute', { selector: link, value: 'href' });
    context.registerSecret(authorizationUrl);
    assert.equal(new URL(new URL(authorizationUrl).searchParams.get('redirect_uri')).pathname, '/oauth/mcp/callback');
    assert.equal(await client.command('getAttribute', { selector: link, value: 'data-absent' }), '');
    const response = await fetch(authorizationUrl);
    assert.equal(response.status, 200);
    await response.text();
    await waitFor(async () => /注销授权|Sign out/.test(await text()), 15000, 'Tauri authorized status', 100, context.abortSignal);
    assert.equal(Number(await client.command('getElementCount', { selector: panel + ' [role="alert"]' })), 0);
    await client.capture('tauri-authorized.png');
    await clickAction();
    await waitFor(async () => /授权登录|Authorize/.test(await text()), 15000, 'Tauri logout state', 100, context.abortSignal);
    await manualLogin();
    await client.command('waitFor', { selector: link, visible: true, timeoutMs: 15000 });
    await clickAction();
    await waitFor(async () => Number(await client.command('getElementCount', { selector: link })) === 0,
      10000, 'Tauri cancellation state', 100, context.abortSignal);
    const remove = panel + ' [data-testid="kcoder-mcp-remove"]';
    await client.command('waitFor', { selector: remove, enabled: true, timeoutMs: 10000 });
    await client.command('click', { selector: remove });
    await client.command('click', { selector: panel + ' [role="alertdialog"] button:first-of-type' });
    await waitFor(async () => Number(await client.command('getElementCount', { selector: panel + ' article' })) === 0,
      10000, 'Tauri MCP configuration removal', 100, context.abortSignal);
    const removed = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    assert.deepEqual(removed.mcp_servers, []);
    assert.deepEqual(removed.providers, settings.providers);
    await context.writeArtifactJson('tauri-mcp-results.json', {
      realTauri: true, installedThroughUi: true, removedThroughUi: true, manualClient: true, authorized: true, loggedOut: true, cancelled: true,
      externalBrowserOpening: 'not tested in deny-all Tauri verifier; browser suite covers navigation',
      events: fixture.events,
    });
  } catch (error) {
    client.markFailed();
    await client.capture('tauri-failure.png').catch(() => {});
    await context.writeArtifactJson('tauri-failure-state.json', JSON.parse(await client.command('snapshot')));
    throw error;
  }
});
