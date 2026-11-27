import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startGatewayPrefixMountProxy } from '../../harness/gateway-prefix-mount-proxy.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { closeRpcAndWait, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

const basePath = '/g/settings-route-nav-owned';
const deviceId = 'local';
const expectedReply = 'SETTINGS_NAVIGATION_FIXTURE_REPLY';

if (!process.env.KCODER_E2E_RENDERER_ROOT) {
  throw new Error('UNMET_PREREQUISITE: explicit renderer build root required');
}
if (!process.env.KCODER_E2E_KCODER_BIN || !process.env.KCODER_E2E_KCODER_BIN_SHA256) {
  throw new Error('UNMET_PREREQUISITE: explicitly pinned KCoder CLI path and SHA256 required');
}
await assertRendererBuildFresh({ buildRoot: process.env.KCODER_E2E_RENDERER_ROOT });

const rendererRoot = await realpath(resolve(process.env.KCODER_E2E_RENDERER_ROOT));
const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'pinned KCoder binary');
assert.equal(await sha256File(binary), process.env.KCODER_E2E_KCODER_BIN_SHA256,
  'KCoder binary must match the explicitly pinned artifact');

await runE2E(import.meta.url, {
  testId: 'desktop-and-responsive-mobile-settings-return-to-original-task-under-base-path',
  tier: 'full-integration',
  modelPolicy: 'authenticated owned loopback Gateway/CLI, deterministic HTTP model fixture and Chromium; no Native or iOS claim',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', {
    instanceId: 'settings-route-navigation',
  });
  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    textOnlyResponse: expectedReply,
  });
  const profile = context.pathInState('gateway-profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await context.writeStateJson('gateway-profile/settings.json', {});
  const apiKey = 'settings-route-navigation-fixture-key';
  context.registerSecret(apiKey);
  await context.writeStateJson('gateway-profile/credentials.json', {
    'settings-route-navigation': { type: 'api', key: apiKey },
  });
  const settingsFile = await context.writeStateJson('local-target-settings.json', {
    active_provider: 'settings-route-navigation',
    providers: {
      'settings-route-navigation': {
        api_format: 'openai_chat_completions',
        endpoint: model.baseUrl,
        default_model: 'settings-route-navigation',
        authentication: { mode: 'api_key' },
        context_window_tokens: 128000,
        max_output_tokens: 2048,
        output_headroom_tokens: 1024,
        no_proxy: true,
      },
    },
  });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: deviceId,
    label: 'Navigation fixture',
    transport: 'local',
    command: binary,
    workspace,
    settingsFile,
  }]);

  const proxy = await startGatewayPrefixMountProxy(context, {
    label: 'settings-route-prefix-proxy',
    prefix: basePath,
  });
  const gateway = await startGateway(context, {
    label: 'settings-route-navigation-gateway',
    workspace,
    serversFile,
    kcoderBin: binary,
    auth: true,
    env: {
      KCODER_CONFIG_DIR: profile,
      KCODER_STUDIO_PUBLIC_ORIGINS: proxy.origin,
      KCODER_STUDIO_PUBLIC_ACCESS_URL: proxy.publicAccessUrl,
    },
  });
  proxy.setGateway(gateway);

  const chromium = await startChromium(context, { label: 'settings-route-navigation-chromium' });
  const desktop = await chromium.newPage({ viewport: { width: 1365, height: 900 }, locale: 'zh-CN' });
  const mobile = await chromium.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  const diagnostics = [];
  const failedRequests = [];
  for (const page of [desktop, mobile]) {
    page.on('pageerror', error => diagnostics.push(error.message));
    page.on('response', response => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      if (url.origin === proxy.origin) failedRequests.push({
        path: url.pathname,
        status: response.status(),
        resourceType: response.request().resourceType(),
      });
    });
  }
  const desktopSessionPath = await openWorkbenchAtPrefix(context, desktop, proxy, 'desktop-sidebar', gateway.authToken,
    diagnostics, failedRequests);
  const thread = await seedActualTask(context, desktop, proxy, deviceId);
  const taskId = `kcoder:${deviceId}:${thread.id}`;
  const taskPath = `/runtime-tasks?deviceId=${deviceId}&taskId=${encodeURIComponent(taskId)}`;
  const expectedTaskUrl = proxy.baseUrl(taskPath);

  await desktop.goto(expectedTaskUrl, { waitUntil: 'domcontentloaded' });
  await assertTaskPage(desktop, basePath, taskId, thread.title, thread.prompt, expectedReply);
  await desktop.getByTestId('settings-button').click();
  await desktop.getByTestId('settings-menu-button').click();
  await waitForLocation(desktop, basePath, '/settings');
  await assertBackPurpose(desktop, 'settings-back-button', '返回任务');
  await desktop.getByTestId('settings-nav-kcoder-servers').click();
  await waitForLocation(desktop, basePath, '/settings/kcoder-servers');
  await desktop.getByTestId('runtime-target-row-local').waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await desktop.locator('meta[name="kcoder-app-base-path"]').getAttribute('content'), basePath);
  await desktop.getByTestId('settings-nav-general').click();
  await waitForLocation(desktop, basePath, '/settings');
  await desktop.getByTestId('settings-back-button').click();
  await assertTaskPage(desktop, basePath, taskId, thread.title, thread.prompt, expectedReply);
  const desktopRestoredTaskUrl = desktop.url();
  await desktop.screenshot({ path: context.pathInArtifacts('desktop-returned-task.png') });

  await desktop.goto(proxy.baseUrl('/settings'), { waitUntil: 'domcontentloaded' });
  await desktop.getByTestId('studio-settings-page').waitFor({ state: 'visible', timeout: 20_000 });
  await assertBackPurpose(desktop, 'settings-back-button', '返回首页');
  await desktop.getByTestId('settings-back-button').click();
  await assertSafeBasePathHome(desktop, proxy.origin, basePath, 'desktop-sidebar');
  const desktopFallbackUrl = desktop.url();

  const mobileSessionPath = await openWorkbenchAtPrefix(context, mobile, proxy, 'open-mobile-drawer-button', gateway.authToken,
    diagnostics, failedRequests);
  await mobile.goto(expectedTaskUrl, { waitUntil: 'domcontentloaded' });
  await assertResponsiveMobileTaskPage(context, mobile, basePath, taskId, thread.prompt, expectedReply);
  await mobile.getByTestId('open-mobile-drawer-button').click();
  await mobile.getByTestId('mobile-settings-button').click();
  await mobile.getByTestId('mobile-settings-page').waitFor({ state: 'visible', timeout: 20_000 });
  await waitForLocation(mobile, basePath, '/settings');
  await assertBackPurpose(mobile, 'mobile-settings-back-button', '返回任务');
  const mobileSettingsLayout = await verifyMobileSettingsDirectoryMatrix(mobile, basePath, context);
  await mobile.getByTestId('mobile-settings-tools-button').click();
  await mobile.getByTestId('mobile-tools-settings-page').waitFor({ state: 'visible', timeout: 20_000 });
  await waitForLocation(mobile, basePath, '/settings/tools');
  await assertBackPurpose(mobile, 'mobile-tools-back-button', '返回设置');
  await mobile.getByTestId('mobile-tools-back-button').click();
  await mobile.getByTestId('mobile-settings-page').waitFor({ state: 'visible', timeout: 20_000 });
  await waitForLocation(mobile, basePath, '/settings');
  await assertBackPurpose(mobile, 'mobile-settings-back-button', '返回任务');
  await mobile.getByTestId('mobile-settings-back-button').click();
  await assertResponsiveMobileTaskPage(context, mobile, basePath, taskId, thread.prompt, expectedReply);
  const mobileRestoredTaskUrl = mobile.url();
  await mobile.screenshot({ path: context.pathInArtifacts('responsive-mobile-returned-task.png') });

  await mobile.goto(proxy.baseUrl('/settings'), { waitUntil: 'domcontentloaded' });
  await mobile.getByTestId('mobile-settings-page').waitFor({ state: 'visible', timeout: 20_000 });
  await assertBackPurpose(mobile, 'mobile-settings-back-button', '返回首页');
  await mobile.getByTestId('mobile-settings-back-button').click();
  await assertSafeBasePathHome(mobile, proxy.origin, basePath, 'open-mobile-drawer-button');
  const mobileFallbackUrl = mobile.url();

  assert.deepEqual(diagnostics, [], 'both browser layouts must return without uncaught page errors');
  await context.writeArtifactJson('settings-task-return-navigation.json', {
    basePath,
    rendererRoot,
    deviceId,
    taskId,
    gatewayAuthentication: true,
    browserSessionPathAttributes: { desktop: desktopSessionPath, mobile: mobileSessionPath },
    desktop: {
      taskToRuntimeTargetToSettingsToTask: true,
      backToTaskLabel: '返回任务',
      restoredTaskUrl: safeUrl(desktopRestoredTaskUrl),
      queryPreserved: new URL(desktopRestoredTaskUrl).search === new URL(expectedTaskUrl).search,
      directSettingsFallback: true,
      directSettingsBackLabel: '返回首页',
      fallbackUrl: safeUrl(desktopFallbackUrl),
    },
    responsiveMobileWeb: {
      viewport: { width: 390, height: 844 },
      taskToToolsSettingsToTask: true,
      mainSettingsBackToTaskLabel: '返回任务',
      toolsBackToSettingsLabel: '返回设置',
      restoredTaskUrl: safeUrl(mobileRestoredTaskUrl),
      queryPreserved: new URL(mobileRestoredTaskUrl).search === new URL(expectedTaskUrl).search,
      directSettingsFallback: true,
      directSettingsBackLabel: '返回首页',
      fallbackUrl: safeUrl(mobileFallbackUrl),
    },
    mobileSettingsDirectory: mobileSettingsLayout,
    nativeOrIosAcceptance: false,
  });
  return {
    nonEmptyBasePath: basePath,
    actualTaskThreadRestored: true,
    desktopRuntimeTargetSettingsReturn: true,
    responsiveMobileWebSettingsReturn: true,
    backDestinationLabels: true,
    taskQueryPreserved: true,
    directSettingsFallback: true,
    mobileSettingsDirectory: mobileSettingsLayout,
    nativeOrIosAcceptance: false,
  };
});

async function verifyMobileSettingsDirectoryMatrix(page, basePath, context) {
  const matrix = [];
  for (const language of ['zh-CN', 'en']) {
    await page.getByTestId('mobile-settings-general-button').click();
    await waitForLocation(page, basePath, '/settings/general');
    const languageButton = page.getByTestId(`general-language-${language}-button`);
    await languageButton.waitFor({ state: 'visible', timeout: 20_000 });
    await languageButton.click();
    await page.waitForFunction(expected => document.documentElement.lang === expected, language, {
      timeout: 20_000,
    });
    await page.getByTestId('mobile-general-back-button').click();
    await waitForLocation(page, basePath, '/settings');
    await page.getByTestId('mobile-settings-page').waitFor({ state: 'visible', timeout: 20_000 });

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: width === 320 ? 740 : 844 });
      const dimensions = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      assert.equal(dimensions.viewport, width);
      assert.ok(Math.max(dimensions.document, dimensions.body) <= width,
        `${language}/${width}px settings directory must not overflow horizontally: ${JSON.stringify(dimensions)}`);
      assert.equal(await page.getByTestId('mobile-settings-page').locator('h1').innerText(),
        language === 'en' ? 'Settings' : '设置');

      const search = page.getByTestId('mobile-settings-search');
      const query = language === 'en' ? 'Channels' : '通道';
      await search.fill(query);
      const channelEntry = page.getByTestId('mobile-settings-channels-button');
      await channelEntry.waitFor({ state: 'visible', timeout: 10_000 });
      assert.match(await channelEntry.innerText(), language === 'en' ? /Channels/ : /通道/);
      await page.screenshot({
        path: context.pathInArtifacts(`mobile-settings-directory-${language}-${width}.png`),
        animations: 'disabled',
      });

      await channelEntry.click();
      await waitForLocation(page, basePath, '/settings/channels');
      await page.getByTestId('mobile-channels-settings-page').waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByTestId('octop-channels-workspace').waitFor({ state: 'visible', timeout: 20_000 });
      assert.equal(await search.count(), 1, 'the hidden settings directory and its search draft remain mounted');
      assert.equal(await search.inputValue(), query);
      assert.equal(await search.isVisible(), false);
      const channelDimensions = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      assert.ok(Math.max(channelDimensions.document, channelDimensions.body) <= width,
        `${language}/${width}px channels page must not overflow horizontally: ${JSON.stringify(channelDimensions)}`);
      await page.screenshot({
        path: context.pathInArtifacts(`mobile-settings-channels-${language}-${width}.png`),
        animations: 'disabled',
      });
      await page.getByTestId('mobile-channels-back-button').click();
      await waitForLocation(page, basePath, '/settings');
      await page.getByTestId('mobile-settings-page').waitFor({ state: 'visible', timeout: 20_000 });
      assert.equal(await search.inputValue(), query, 'returning from Channels must preserve the search draft');
      assert.equal(await channelEntry.evaluate(node => document.activeElement === node), true,
        'returning from a settings detail page must restore focus to its directory entry');
      matrix.push({ language, width, directory: true, hiddenSearchDraftRetained: true, channelRoute: true });
      await search.fill('');
    }
  }

  await page.getByTestId('mobile-settings-general-button').click();
  await waitForLocation(page, basePath, '/settings/general');
  await page.getByTestId('general-language-zh-CN-button').click();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN', undefined, {
    timeout: 20_000,
  });
  await page.getByTestId('mobile-general-back-button').click();
  await waitForLocation(page, basePath, '/settings');
  await page.setViewportSize({ width: 390, height: 844 });
  return { widths: [320, 390], languages: ['zh-CN', 'en'], route: '/settings/channels', cases: matrix };
}

async function openWorkbenchAtPrefix(context, page, proxy, readinessTestId, gatewayToken, diagnostics, failedRequests) {
  const login = new URL(`${basePath}/login`, proxy.origin);
  login.search = new URLSearchParams({ token: gatewayToken, returnTo: `${basePath}/` }).toString();
  await page.goto(login.href, { waitUntil: 'commit' });
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
  const cookie = (await page.context().cookies()).find(item => item.name === 'kcoder_studio_session');
  const document = await page.evaluate(() => ({
    path: location.pathname,
    basePath: document.querySelector('meta[name="kcoder-app-base-path"]')?.getAttribute('content') ?? null,
    assets: [...document.querySelectorAll('script[src],link[href],form[action]')]
      .map(element => element.getAttribute('src') || element.getAttribute('href') || element.getAttribute('action'))
      .filter(Boolean),
  }));
  const evidenceName = readinessTestId === 'desktop-sidebar'
    ? 'desktop-prefix-login-document.json'
    : 'responsive-mobile-prefix-login-document.json';
  await context.writeArtifactJson(evidenceName, {
    loginRedirectPath: new URL(page.url()).pathname,
    document,
    sessionPathAttribute: cookie?.path ?? null,
    failedRequests: [...failedRequests],
  });
  assert.ok(cookie, 'the browser must receive the Gateway session cookie through the real login flow');
  assert.equal(cookie.path, `${basePath}/`, 'the Gateway session cookie must be scoped to the mounted basePath');
  try {
    await page.getByTestId(readinessTestId).waitFor({ state: 'visible', timeout: 60_000 });
  } catch (error) {
    await context.writeArtifactJson(evidenceName, {
      loginRedirectPath: new URL(page.url()).pathname,
      document,
      sessionPathAttribute: cookie.path,
      failedRequests: [...failedRequests],
      pageErrors: [...diagnostics],
      readyTestId: readinessTestId,
      ready: false,
    });
    await page.screenshot({ path: context.pathInArtifacts(evidenceName.replace('.json', '.png')) }).catch(() => {});
    throw error;
  }
  assert.equal(
    await page.locator('meta[name="kcoder-app-base-path"]').getAttribute('content'),
    basePath,
    'the Gateway must inject this run-owned non-empty application basePath',
  );
  return cookie.path;
}

async function seedActualTask(context, page, proxy, serverId) {
  const token = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content');
  assert.ok(token, 'the signed-in app shell must expose its own RPC token');
  context.registerSecret(token);
  const cookies = await page.context().cookies();
  const session = cookies.find(item => item.name === 'kcoder_studio_session' && item.path === `${basePath}/`);
  assert.ok(session, 'the seed RPC must use the mounted Gateway session cookie issued to this browser');
  const cookie = `${session.name}=${session.value}`;
  context.registerSecret(cookie);
  const rpcUrl = new URL(`${proxy.origin.replace(/^http/, 'ws')}${basePath}/rpc`);
  rpcUrl.search = new URLSearchParams({ token, server: serverId }).toString();
  const rpc = await openRpc(rpcUrl.href, { headers: { Cookie: cookie, Origin: proxy.origin } });
  context.addCleanup('close settings navigation seed RPC', () => closeRpcAndWait(rpc, 'settings navigation seed RPC'));
  await initializeRpc(rpc, 'settings-return-navigation-seeder');
  const started = await rpc.request('thread/start', {});
  const title = 'SETTINGS_NAVIGATION_SOURCE_TASK';
  const prompt = 'SETTINGS_NAVIGATION_SOURCE_PROMPT';
  const turn = await rpc.request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: prompt }],
  });
  await rpc.waitFor(
    message => message.method === 'turn/completed' && message.params?.threadId === started.thread.id &&
      message.params?.turnId === turn.turn.id,
    30_000,
    'settings navigation source task turn completion',
  );
  await rpc.request('thread/metadata/update', { threadId: started.thread.id, title });
  await closeRpcAndWait(rpc, 'settings navigation seed RPC');
  return { id: started.thread.id, title, prompt };
}

async function assertTaskPage(page, prefix, taskId, title, prompt, reply) {
  const expectedPath = `${prefix}/runtime-tasks`;
  await page.waitForURL(url => url.pathname === expectedPath, { timeout: 30_000 });
  const url = new URL(page.url());
  assert.equal(url.pathname, expectedPath);
  assert.equal(url.searchParams.get('deviceId'), deviceId);
  assert.equal(url.searchParams.get('taskId'), taskId);
  assert.equal(await page.locator('meta[name="kcoder-app-base-path"]').getAttribute('content'), prefix);
  await page.getByTestId('workbench-pane-task-title').getByText(title, { exact: true })
    .waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByText(prompt, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByText(reply, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
}

async function assertResponsiveMobileTaskPage(context, page, prefix, taskId, prompt, reply) {
  try {
    const expectedPath = `${prefix}/runtime-tasks`;
    await page.waitForURL(url => url.pathname === expectedPath, { timeout: 30_000 });
    const url = new URL(page.url());
    assert.equal(url.pathname, expectedPath);
    assert.equal(url.searchParams.get('deviceId'), deviceId);
    assert.equal(url.searchParams.get('taskId'), taskId);
    assert.equal(await page.locator('meta[name="kcoder-app-base-path"]').getAttribute('content'), prefix);
    await page.getByTestId('mobile-conversation-header').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText(prompt, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText(reply, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const pageEvidence = await page.evaluate(() => ({
      path: location.pathname,
      search: location.search,
      basePath: document.querySelector('meta[name="kcoder-app-base-path"]')?.getAttribute('content') ?? null,
      bodyText: document.body.innerText.slice(0, 6000),
      testIds: [...document.querySelectorAll('[data-testid]')]
        .map(element => element.getAttribute('data-testid')).filter(Boolean).slice(0, 150),
    })).catch(() => null);
    await context.writeArtifactJson('responsive-mobile-task-page-failure.json', {
      page: pageEvidence,
      pageErrors: context.redactText(JSON.stringify(error instanceof Error ? error.message : String(error))),
    });
    await page.screenshot({ path: context.pathInArtifacts('responsive-mobile-task-page-failure.png') }).catch(() => {});
    throw error;
  }
}

async function assertSafeBasePathHome(page, expectedOrigin, prefix, readinessTestId) {
  const url = new URL(page.url());
  assert.equal(url.origin, expectedOrigin);
  assert.ok(url.pathname === `${prefix}/` || url.pathname === prefix,
    `direct Settings should safely return to the owned app root, got ${url.pathname}`);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  await page.getByTestId(readinessTestId).waitFor({ state: 'visible', timeout: 30_000 });
}

async function waitForLocation(page, prefix, path) {
  await page.waitForURL(url => url.pathname === `${prefix}${path}`, { timeout: 10_000 });
}

async function assertBackPurpose(page, testId, expectedLabel) {
  const button = page.getByTestId(testId);
  await button.waitFor({ state: 'visible', timeout: 20_000 });
  const accessibleLabel = await button.getAttribute('aria-label');
  const actualLabel = accessibleLabel ?? (await button.innerText()).trim();
  assert.equal(actualLabel, expectedLabel, `${testId} must name its return destination`);
}

function safeUrl(value) {
  const url = new URL(value);
  return { pathname: url.pathname, search: url.search, hash: url.hash };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
