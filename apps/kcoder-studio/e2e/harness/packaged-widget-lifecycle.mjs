import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { appRoot, requireExecutable, waitFor } from './run-context.mjs';
import { startPackagedDesktop } from './packaged-desktop.mjs';
import { startApprovalModelFixture } from './approval-model.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';

/** Actual packaged Windows native admission and parent/probe presentation; no model-quality claim. */
export async function verifyPackagedWidgetLifecycle(context, root) {
  assert.equal(process.platform, 'win32', 'UNMET_PREREQUISITE: actual Windows is required');
  assert.notEqual(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1');
  const manifest = JSON.parse(await readFile(join(root, 'resources/kcoder-release-manifest.json'), 'utf8'));
  const expected = process.env.KCODER_RELEASE_EXPECTED_COMMIT;
  assert.match(expected ?? '', /^[0-9a-f]{40}$/, 'An explicit full product commit is required');
  assert.equal(manifest.packagingSource?.commit, expected, 'Frozen product commit must match the actual package manifest');
  assert.equal(manifest.packagingSource?.dirty, false, 'Actual package must come from clean frozen source');
  const asar = await readFile(join(root, 'resources/app.asar'));
  const nativeInputs = [];
  for (const file of ['desktop/widget-isolation/controller.mjs', 'desktop/widget-isolation/policy.mjs', 'desktop/menu-preload.cjs']) {
    const bytes = await readFile(join(appRoot, file));
    assert.ok(asar.includes(bytes), `Actual app.asar does not contain the frozen production ${file}`);
    nativeInputs.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const sandboxInputs = {};
  for (const name of ['isolated-v1.html', 'isolated-policy-v1.json']) {
    const sourcePath = `renderer/public/widget-sandbox/${name}`;
    const resourcePath = `renderer-dist/widget-sandbox/${name}`;
    const frozenBytes = await readFile(join(appRoot, sourcePath));
    const packagedBytes = await readFile(join(root, 'resources', resourcePath));
    assert.deepEqual(packagedBytes, frozenBytes, `Actual isolated resource differs from frozen source: ${name}`);
    const sha256 = createHash('sha256').update(frozenBytes).digest('hex');
    assert.equal(manifest.resources.find(resource => resource.path === resourcePath)?.sha256, sha256);
    nativeInputs.push({ file: sourcePath, sha256 });
    sandboxInputs[name] = frozenBytes;
  }
  const isolatedPolicy = JSON.parse(sandboxInputs['isolated-policy-v1.json'].toString('utf8'));
  assert.equal(isolatedPolicy.requiresNativeProcessAuthorization, true);
  assert.equal(isolatedPolicy.documentSha256, createHash('sha256').update(sandboxInputs['isolated-v1.html']).digest('hex'));
  const cli = await requireExecutable(join(root, 'resources/bin/kcoder.exe'), 'packaged Windows CLI');
  for (const directory of ['Downloads', 'Desktop', 'Documents', 'AppData/Local', 'AppData/Roaming']) await mkdir(context.pathInState('home', directory), { recursive: true });
  const outcomes = [];
  for (const outcome of ['success', 'cancel', 'failure']) {
    const marker = `owned-native-${outcome}`;
    let releaseFinal = false;
    const chartMarkup = outcome === 'success' ? '<button id="native-show-chart">Show chart</button><div id="native-chart-area" style="display:none;height:260px"><canvas id="native-chart"></canvas></div>' : '';
    const chartScript = outcome === 'success' ? `const nativeChart=new Chart(document.getElementById('native-chart'),{type:'bar',data:{labels:['A','B'],datasets:[{label:'Owned values',data:[2,5],backgroundColor:'#3589df'}]},options:{responsive:true,maintainAspectRatio:false,animation:false}});document.getElementById('native-show-chart').onclick=()=>{document.getElementById('native-chart-area').style.display='block';nativeChart.resize();nativeChart.update('none')};` : '';
    const source = `<h2>Native calculation</h2><input id="native-years" type="range" min="1" max="10" value="7"><output id="native-value"></output>${chartMarkup}<script>${chartScript}const input=document.getElementById('native-years');const output=document.getElementById('native-value');function update(){output.textContent=String(Number(input.value)*6);let blocked=false;try{parent.document.body.innerHTML}catch{blocked=true}const canvas=document.getElementById('native-chart');parent.postMessage({type:'owned-native-lifecycle-proof',marker:${JSON.stringify(marker)},value:Number(output.textContent),parentDomBlocked:blocked,noNativeApi:typeof require==='undefined'&&typeof process==='undefined'&&typeof kcoderDesktopHost==='undefined',chart:canvas?{width:canvas.width,height:canvas.height,cssWidth:canvas.getBoundingClientRect().width,cssHeight:canvas.getBoundingClientRect().height,version:Chart.version}:null},'*')}input.oninput=update;update()</script>`;
    const model = await startApprovalModelFixture(context, {
      httpErrorPrompt: outcome === 'failure' ? marker : undefined, httpErrorAfterToolResults: 1,
      httpErrorStatus: 400, httpErrorCode: 'invalid_request_error', httpErrorMessage: 'owned-native-intentional-failure',
      responseSteps: ({ body }) => body.messages.some(message => message.role === 'tool')
        ? [{ ready: () => releaseFinal, delta: { role: 'assistant', content: `NATIVE_FINAL_${outcome}` } }, { finishReason: 'stop' }]
        : [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: marker, type: 'function', function: { name: 'show_widget', arguments: JSON.stringify({ title: 'Native calculation', summary: 'Owned synthetic six-times calculation', widget_code: source, format: 'html', execution_mode: 'isolated_html', libraries: outcome === 'success' ? ['chart_js'] : [] }) } }] } }, { finishReason: 'tool_calls' }],
    });
    const workspace = await materializeWorkspace(context, 'minimal', { instanceId: `native-${outcome}` });
    const namespace = `native-${outcome}`;
    const servers = await context.writeStateJson(`${namespace}/servers.json`, [{ id: 'local', label: 'Owned native package fixture', transport: 'local', command: cli, workspace: workspace.path }]);
    await context.writeStateJson(`${namespace}/home/settings.json`, {
      active_provider: 'native-fixture', knowledge: { enabled: false },
      providers: { 'native-fixture': { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'native-fixture', context_window_tokens: 131072, max_output_tokens: 2048, output_headroom_tokens: 2048, max_retries: 0, no_proxy: true } },
    });
    await context.writeStateJson(`${namespace}/home/credentials.json`, {});
    const desktop = await startPackagedDesktop(context, { root, label: namespace, servers, workspace: workspace.path, profileNamespace: namespace });
    try {
      const { page, browser } = desktop;
      const notificationDiagnostics = [];
      const loadingDiagnostics = [];
      const exceptionDiagnostics = [];
      desktop.loadingDiagnostics = loadingDiagnostics;
      desktop.exceptionDiagnostics = exceptionDiagnostics;
      page.on('response', async response => {
        const path = new URL(response.url()).pathname;
        if (!/\.(?:m?js)$/.test(path) || loadingDiagnostics.length >= 40) return;
        const bytes = await response.body().catch(() => null);
        loadingDiagnostics.push({ path, status: response.status(), contentType: response.headers()['content-type'], bytes: bytes?.length, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : undefined });
      });
      page.on('requestfailed', request => {
        const path = new URL(request.url()).pathname;
        if (loadingDiagnostics.length < 40) loadingDiagnostics.push({ path, failure: request.failure()?.errorText });
      });
      page.on('console', message => {
        if (message.type() === 'error' && exceptionDiagnostics.length < 40)
          exceptionDiagnostics.push({ kind: 'console', message: message.text().slice(0, 1600) });
      });
      const readRequests = new Map();
      const readDiagnostics = [];
      const network = await page.context().newCDPSession(page);
      await network.send('Network.enable');
      if (process.env.KCODER_E2E_WIDGET_DIAGNOSTICS === '1') {
        await network.send('Debugger.enable');
        network.on('Debugger.paused', async event => {
          if (exceptionDiagnostics.length < 40) exceptionDiagnostics.push({ kind: event.reason, description: event.data?.description, frames: event.callFrames.slice(0, 4).map(frame => ({ functionName: frame.functionName, url: frame.url, lineNumber: frame.location.lineNumber, columnNumber: frame.location.columnNumber })) });
          await network.send('Debugger.resume').catch(() => {});
        });
        await network.send('Debugger.setPauseOnExceptions', { state: 'all' });
      }
      network.on('Network.webSocketFrameSent', ({ response, requestId }) => {
        if (readRequests.size >= 64) return;
        try {
          const value = JSON.parse(response.payloadData);
          if (value.method === 'widget/read' && value.id != null) readRequests.set(`${requestId}:${JSON.stringify(value.id)}`, value.params);
        } catch { /* Only the real read RPC is relevant to this observation. */ }
      });
      network.on('Network.webSocketFrameReceived', ({ response, requestId }) => {
        try {
          const value = JSON.parse(response.payloadData);
          const readKey = `${requestId}:${JSON.stringify(value.id)}`;
          if (readRequests.has(readKey) && readDiagnostics.length < 64) {
            const reference = value.result?.widget;
            readDiagnostics.push({ request: readRequests.get(readKey), widgetId: reference?.widgetId, revision: reference?.revision, sha256: reference?.sha256, observation: value.result?.renderObservation ?? null, error: value.error?.message });
          }
          if (notificationDiagnostics.length >= 20 || !response.payloadData?.includes('widgetRef')) return;
          const visit = (item, depth = 0) => {
            if (!item || typeof item !== 'object' || depth > 5) return;
            if (item.item?.widgetRef) notificationDiagnostics.push({ threadId: item.threadId, turnId: item.turnId, attemptId: item.attemptId, turn: item.turn, widgetRef: item.item.widgetRef, itemStatus: item.item.status });
            for (const child of Object.values(item)) if (typeof child === 'object') visit(child, depth + 1);
          };
          visit(value);
        } catch { /* Non-JSON transport frames are irrelevant to artifact identity. */ }
      });
      desktop.notificationDiagnostics = notificationDiagnostics;
      desktop.readDiagnostics = readDiagnostics;
      const capability = await page.evaluate(() => window.kcoderDesktopHost.widgets.getCapabilities());
      assert.equal(capability.isolatedHtml, true, 'Actual production native admission must be available');
      const userAgent = await page.evaluate(() => navigator.userAgent);
      assert.match(userAgent, /Electron\/42\.3\.3/); assert.match(userAgent, /Chrome\/148\./);
      await page.getByRole('button', { name: 'KWorker', exact: true }).click();
      await page.evaluate(marker => {
        const state = window.__ownedNativeLifecycle = { proofs: [], beforeFinalVisible: [], finalAllowed: false, snapshots: [] };
        const capture = () => {
          const identities = []; const references = []; const providers = [];
          for (const node of document.querySelectorAll('[data-testid="message-hover-region"], [data-testid="widget-deferred-status"], [data-testid="widget-unavailable"], [data-testid="chat-message-input"]')) {
            let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
            for (let depth = 0; fiber && depth < 120; depth++, fiber = fiber.return) {
              const props = fiber.memoizedProps;
              if (props?.identity && typeof props.identity.terminal === 'boolean') identities.push({ ...props.identity });
              if (props?.value?.references && props.value.threadId) {
                providers.push({ threadId: props.value.threadId, invalidated: props.value.invalidated, listingStatus: props.value.listingStatus, hostPanelId: props.value.hostPanelId, hostPanelIdLength: props.value.hostPanelId?.length, probePanelIdLength: props.value.hostPanelId?.length + ':probe'.length });
                for (const ref of props.value.references) references.push({ widgetId: ref.widgetId, revision: ref.revision, threadId: ref.threadId, turnId: ref.turnId, attemptId: ref.attemptId, toolCallId: ref.toolCallId });
              }
            }
          }
          const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()].slice(0, 20);
          const snapshot = {
            identities: unique(identities), references: unique(references), providers: unique(providers),
            probes: document.querySelectorAll('[data-testid="widget-first-frame-probe"]').length,
            hosts: [...document.querySelectorAll('[data-testid="inline-widget"]')].map(node => ({ status: node.getAttribute('data-widget-status'), hidden: Boolean(node.closest('[aria-hidden=true]')), height: node.getBoundingClientRect().height })),
            frames: [...document.querySelectorAll('iframe')].map(frame => ({ path: new URL(frame.src || location.href).pathname, probe: Boolean(frame.closest('[data-testid="widget-first-frame-probe"]')), height: frame.getBoundingClientRect().height })),
            groups: [...document.querySelectorAll('[data-testid="processing-summary-toggle"], [data-testid="processing-activity-group-toggle"]')].map(node => ({ testId: node.getAttribute('data-testid'), expanded: node.getAttribute('aria-expanded') })),
            status: [...document.querySelectorAll('[data-testid="widget-deferred-status"], [data-testid="widget-unavailable"]')].map(node => ({ testId: node.getAttribute('data-testid'), text: node.textContent?.slice(0, 200) })),
          };
          const serialized = JSON.stringify(snapshot);
          if (state.lastSnapshot !== serialized && state.snapshots.length < 100) state.snapshots.push({ atMs: Math.round(performance.now()), ...snapshot });
          state.lastSnapshot = serialized;
        };
        setInterval(capture, 100);
        const scan = () => {
          if (state.finalAllowed) return;
          const count = [...document.querySelectorAll('[data-testid="inline-widget"]')].filter(node => !node.closest('[aria-hidden=true]')).length;
          if (count && state.beforeFinalVisible.length < 20) state.beforeFinalVisible.push(count);
        };
        new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true });
        addEventListener('message', event => {
          if (event.data?.type !== 'owned-native-lifecycle-proof' || event.data.marker !== marker) return;
          const iframe = [...document.querySelectorAll('iframe')].find(frame => frame.contentWindow === event.source);
          if (!iframe || new URL(iframe.src).pathname !== '/api/widgets/isolated-v1.html') return;
          const probe = iframe.closest('[data-testid="widget-first-frame-probe"]');
          state.proofs.push({ ...event.data, hiddenProbe: Boolean(probe), probeOpacity: probe ? getComputedStyle(probe).opacity : null, frameSandbox: iframe.getAttribute('sandbox') });
        });
      }, marker);
      const editor = page.getByTestId('chat-message-input');
      await editor.click(); await page.keyboard.insertText(`Create the owned native visualization: ${marker}`);
      await page.getByTestId('send-message-button').click();
      await waitFor(async () => {
        const permission = page.locator('[data-testid^="request-user-input-option-"]').first();
        if (await permission.isVisible().catch(() => false)) await permission.click();
        return model.requests.some(body => body.messages.some(message => message.role === 'tool'));
      }, 45000, 'actual packaged show_widget result and native first-frame feedback');
      await page.evaluate(async marker => {
        const node = document.querySelector('[data-testid="message-hover-region"]');
        let fiber = node?.[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
        for (let depth = 0; fiber && depth < 120; depth++, fiber = fiber.return) {
          const value = fiber.memoizedProps?.value;
          if (value?.references && value.threadId && value.api?.list) {
            window.__ownedNativeLifecycle.authoritativeList = await value.api.list().then(refs => refs.map(ref => ({ widgetId: ref.widgetId, revision: ref.revision, threadId: ref.threadId, turnId: ref.turnId, attemptId: ref.attemptId, toolCallId: ref.toolCallId })), error => ({ error: String(error.message) }));
            const reference = value.references.find(ref => ref.toolCallId === marker);
            if (reference) window.__ownedNativeLifecycle.currentRead = await value.api.read(reference.widgetId, reference.revision);
            break;
          }
        }
      }, marker);
      const toolMessages = model.requests.flatMap(body => body.messages.filter(message => message.role === 'tool'));
      const expectedStatus = outcome === 'success' ? 'unconfirmed' : 'rendered';
      const result = toolMessages.find(message => message.tool_call_id === marker);
      const renderObservation = String(result?.content).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(value => value.render_status);
      assert.equal(renderObservation?.render_status, expectedStatus, 'Zero-sized charts stay unconfirmed; static native first frames must be acknowledged');
      const running = await page.evaluate(() => window.__ownedNativeLifecycle);
      assert.deepEqual(running.beforeFinalVisible, []);
      assert.ok(running.proofs.some(proof => proof.hiddenProbe && proof.probeOpacity === '0' && proof.parentDomBlocked && proof.noNativeApi && proof.value === 42), 'The real hidden native JavaScript frame must execute without parent/native access');
      if (outcome === 'success') {
        assert.ok(running.proofs.some(proof => proof.chart?.cssWidth === 0 && proof.chart.cssHeight === 0 && proof.chart.version === '4.5.1'), 'The initial native Chart must genuinely have no drawable layout');
        await waitFor(() => readDiagnostics.some(read => read.widgetId === running.currentRead?.widgetId), 3000, 'authoritative initial widget read RPC');
        assert.equal(readDiagnostics.at(-1).observation, null, 'A zero-sized native chart must not persist a false rendered observation');
        await page.evaluate(() => { window.__ownedNativeLifecycle.finalAllowed = true; });
        releaseFinal = true;
        await page.getByText('NATIVE_FINAL_success', { exact: true }).waitFor({ timeout: 30000 });
        const hosts = page.locator('[data-testid="inline-widget"]:not([aria-hidden=true]):not([aria-hidden=true] *)');
        await waitFor(async () => await hosts.count() === 1, 15000, 'one final native component');
        await hosts.waitFor();
        const frame = page.frameLocator('iframe[title="Native calculation"]');
        await frame.locator('#native-value').filter({ hasText: '42' }).waitFor();
        await frame.locator('#native-show-chart').click();
        await waitFor(() => hosts.getAttribute('data-widget-status').then(status => status === 'ready'), 5000, 'native chart becomes ready after the real user reveals it');
        const drawing = await frame.locator('#native-chart').evaluate(canvas => {
          const chart = globalThis.Chart.getChart(canvas);
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          return { width: canvas.width, height: canvas.height, cssWidth: canvas.getBoundingClientRect().width, cssHeight: canvas.getBoundingClientRect().height, version: globalThis.Chart.version, values: chart.data.datasets[0].data, elements: chart.getDatasetMeta(0).data.length, painted: pixels.some((value, index) => index % 4 === 3 && value > 0) };
        });
        assert.ok(drawing.width > 0 && drawing.height > 0 && drawing.cssWidth > 0 && drawing.cssHeight > 0 && drawing.painted);
        assert.deepEqual(drawing.values, [2, 5]); assert.equal(drawing.elements, 2);
        await waitFor(async () => {
          await page.evaluate(async () => {
            const node = document.querySelector('[data-testid="message-hover-region"]');
            let fiber = node?.[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
            for (let depth = 0; fiber && depth < 120; depth++, fiber = fiber.return) {
              const value = fiber.memoizedProps?.value;
              if (value?.references && value.threadId && value.api?.read) {
                const reference = window.__ownedNativeLifecycle.currentRead;
                await value.api.read(reference.widgetId, reference.revision);
                break;
              }
            }
          });
          return readDiagnostics.at(-1)?.observation?.status === 'rendered';
        }, 5000, 'the same revision gains a real stored rendered observation after drawing');
        assert.equal(readDiagnostics.at(-1).widgetId, running.currentRead.widgetId);
        assert.equal(readDiagnostics.at(-1).revision, running.currentRead.revision);
        assert.equal(readDiagnostics.at(-1).sha256, running.currentRead.sha256);
        assert.equal(readDiagnostics.at(-1).observation.errorCode ?? null, null);
        await context.writeArtifactJson('native-chart-zero-to-visible.json', { initial: readDiagnostics[0], drawing, afterDrawing: readDiagnostics.at(-1), meaning: 'A later valid same-revision observation follows real user interaction; read itself is not a rendering inspection.' });
        await frame.locator('#native-years').focus(); await page.keyboard.press('ArrowRight');
        await frame.locator('#native-value').filter({ hasText: '48' }).waitFor();
      } else if (outcome === 'cancel') {
        await page.getByTestId('pause-response-button').click();
        await page.getByTestId('assistant-stopped-notice').waitFor({ timeout: 20000 });
        assert.equal(await page.locator('[data-testid="inline-widget"]:not([aria-hidden=true]):not([aria-hidden=true] *)').count(), 0);
      } else {
        await page.getByTestId('assistant-error-card').waitFor({ timeout: 20000 });
        assert.equal(await page.locator('[data-testid="inline-widget"]:not([aria-hidden=true]):not([aria-hidden=true] *)').count(), 0);
      }
      assert.equal(await page.getByTestId('widget-svg-prefix').count(), 0);
      assert.equal(await page.getByTestId('widget-chart-checkpoint').count(), 0);
      const cdp = await browser.newBrowserCDPSession();
      const processes = await cdp.send('SystemInfo.getProcessInfo');
      await cdp.detach();
      const receipt = { outcome, capability, userAgent, modelRequests: model.requests.length, proof: await page.evaluate(() => window.__ownedNativeLifecycle), readDiagnostics, actualBrowserProcesses: processes.processInfo, processingObservation: expectedStatus, firstFrame: outcome === 'success' ? 'initial native chart layout unconfirmed; real final canvas painting verified after user interaction' : 'real hidden native first frame acknowledged', packagedRendererUsed: true };
      outcomes.push(receipt);
      await page.screenshot({ path: context.pathInArtifacts(`native-lifecycle-${outcome}.png`) });
      await context.writeArtifactJson(`native-lifecycle-${outcome}.json`, receipt);
    } catch (error) {
      await context.writeArtifactJson(`native-lifecycle-${outcome}-failure.json`, { error: String(error.message), modelRequests: model.requests.length, widgetToolOffered: model.requests[0]?.tools?.some(tool => tool.function?.name === 'show_widget'), toolResults: model.requests.flatMap(body => body.messages.filter(message => message.role === 'tool')).map(message => JSON.stringify(message).slice(0, 8192)), notifications: desktop.notificationDiagnostics, readDiagnostics: desktop.readDiagnostics, loadingDiagnostics: desktop.loadingDiagnostics, exceptionDiagnostics: desktop.exceptionDiagnostics, parent: await desktop.page.evaluate(() => window.__ownedNativeLifecycle).catch(() => null) });
      await desktop.page.screenshot({ path: context.pathInArtifacts(`native-lifecycle-${outcome}-failure.png`) }).catch(() => {});
      throw error;
    } finally { await desktop.stop(); }
  }
  const report = { expectedProductCommit: expected, nativeInputs, outcomes, actualWindows: true, actualPackage: true, modelQualityTested: false, paidModelCalls: 0, installed: false, remoteCompiled: false };
  await context.writeArtifactJson('packaged-native-widget-lifecycle.json', report);
  return report;
}
