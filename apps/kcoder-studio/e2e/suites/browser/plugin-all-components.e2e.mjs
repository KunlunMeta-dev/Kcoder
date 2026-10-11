import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// QA: actual Studio install and new conversation without application restart.
// Fixed tool choice tests discovery and execution, not model behavior quality.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'studio-plugin-skill-hook-mcp-new-conversation', tier: 'full-integration',
  modelPolicy: 'model-independent real browser/Gateway/CLI/stdio MCP and shell Hook',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'bundle' });
  const source = context.pathInState('marketplace');
  const plugin = resolve(source, 'bundle');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  await mkdir(resolve(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(resolve(plugin, 'skills/bundle-fixture'), { recursive: true });
  await writeFile(resolve(source, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'bundle-market', owner: { name: 'Fixture' }, plugins: [{ name: 'bundle', source: './bundle' }] }));
  await writeFile(resolve(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'bundle', version: '1.0.0', skills: './skills',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', shell: 'bash', command: 'printf x >> bundle-hook-count' }] }] },
    mcpServers: { probe: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/mcp.cjs', resolve(workspace, 'mcp-count')] } },
  }));
  await writeFile(resolve(plugin, 'skills/bundle-fixture/SKILL.md'), '---\nname: bundle-fixture\ndescription: Owned bundle fixture\n---\nBUNDLE_SKILL_BODY\n');
  await copyFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/component-probe-mcp.cjs'), resolve(plugin, 'mcp.cjs'));
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    if (body.messages.some(message => message.role === 'tool')) return [{ delta: { role: 'assistant', content: 'BUNDLE_COMPONENTS_DONE' }, finishReason: 'stop' }];
    const mcp = body.tools.find(tool => tool.function.name.endsWith('bundle_probe'));
    assert.ok(mcp, 'new conversation must discover plugin MCP');
    assert.ok(body.tools.some(tool => tool.function.name === 'skill'));
    return [{ delta: { role: 'assistant', tool_calls: [
      { index: 0, id: 'bundle-skill', type: 'function', function: { name: 'skill', arguments: JSON.stringify({ skill: 'bundle-fixture' }) } },
      { index: 1, id: 'bundle-mcp', type: 'function', function: { name: mcp.function.name, arguments: '{}' } },
    ] }, finishReason: 'tool_calls' }];
  } });
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0, skills: { trust_external: true },
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } } });
  await context.writeStateJson('config/credentials.json', {});
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Bundle fixture', transport: 'local', command: resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/full-profile-kcoder.mjs'), workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: context.pathInState('config'), KCODER_E2E_KCODER_BIN: binary } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
  await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { window.__bundleDocumentIdentity = 'owned-bundle-page'; });
  await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
  await page.getByTestId('plugins-button').click();
  await page.getByTestId('plugins-add-marketplace-button').click();
  await page.getByTestId('plugins-add-custom-marketplace-button').click();
  await page.getByTestId('plugins-marketplace-path-input').fill(source);
  await page.getByTestId('plugins-marketplace-trust-directory').check();
  await page.getByTestId('plugins-marketplace-save-button').click();
  const install = page.getByTestId('plugin-marketplace-install-bundle@bundle-market');
  await install.waitFor({ timeout: 30000 });
  await install.click();
  await page.getByRole('button', { name: '在对话中试用', exact: true }).waitFor({ timeout: 30000 });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close bundle inventory RPC', () => rpc.close());
  await initializeRpc(rpc, 'bundle-components');
  const installed = (await rpc.request('plugin/read', { pluginId: 'bundle@bundle-market' })).plugin;
  for (const kind of ['skill', 'hook', 'mcp']) assert.ok(installed.components.some(component => component.kind === kind));
  const mcp = await rpc.request('mcp/list');
  assert.ok(mcp.servers.some(server => server.pluginId === installed.id));
  await page.locator('[data-testid="new-chat-button"]:visible').first().click();
  assert.equal(await page.evaluate(() => window.__bundleDocumentIdentity), 'owned-bundle-page', 'install and new conversation must not reload the document');
  const project = page.locator('[data-testid="project-item"]:visible').filter({ hasText: 'Bundle fixture' }).first();
  await project.hover();
  await project.getByTestId('project-new-conversation-button').click();
  await page.getByTestId('chat-message-input').click();
  await page.keyboard.insertText('BUNDLE_ACTIVATE');
  await page.getByTestId('send-message-button').click();
  await page.getByText('BUNDLE_COMPONENTS_DONE', { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await readFile(resolve(workspace, 'bundle-hook-count'), 'utf8'), 'x');
  assert.equal(await readFile(resolve(workspace, 'mcp-count'), 'utf8'), 'x');
  assert.ok(JSON.stringify(model.requests.at(-1).messages).includes('Activated skill: bundle-fixture'));
  assert.ok(JSON.stringify(model.requests.at(-1).messages).includes('BUNDLE_PROBE_OK'));
  assert.equal(gateway.child.exitCode, null);
  // Keep one screenshot as evidence of all-component activation in the running Studio.
  await page.screenshot({ path: context.pathInArtifacts('bundle-components-complete.png') });
  await context.writeArtifactJson('bundle-results.json', { installedViaStudio: true, noApplicationRestart: true, skillActivated: true, hookCalls: 1, mcpCalls: 1, componentOwnership: installed.id });
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('bundle-failure.png') }).catch(() => {});
    throw error;
  } finally { await page.close(); }
});
