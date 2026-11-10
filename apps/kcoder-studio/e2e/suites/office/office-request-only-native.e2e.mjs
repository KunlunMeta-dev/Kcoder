import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoveryCall, documentCall, toolResult, toolSteps } from './native-download-model.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { nativeOfficeFixture } from '../../harness/native-office-fixture.mjs';
import { sha256File } from '../../harness/native-code-service.mjs';
import { createNativeSystemdUser } from '../../harness/native-systemd-user.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { enableNativeOfficeInPage } from './native-setup-flow.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'ordinary-office-request-only-page-to-native-adoption', tier: 'full-integration',
  modelPolicy: 'Authenticated real Gateway and native Engine; at most three loopback responses. Optional file proof uses the original Ask approval UI and real OfficeDocument/full-byte export. No external model or content-quality claim.',
  retainSuccessEvidence: true,
  processSignalTimeoutMs: 15000,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit current request-schema native binary');
  assert.match(process.env.KCODER_E2E_KCODER_BIN_SHA256 || '', /^[a-f0-9]{64}$/);
  assert.equal(await sha256File(binary), process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const requestText = `介绍北京，整理成简明文档。 OFFICE_REQUEST_ONLY_${context.seed}`;
  const submittedRequest = `${requestText}\n\n请根据需求选择合适的文件格式，生成可编辑的实际文件并交付下载；不要仅以文字答复代替文件。`;
  const fileProof = process.env.KCODER_E2E_OFFICE_FILE_PROOF === '1';
  let expectedRequests = fileProof ? 3 : 1;
  const schemaObservations = [];
  const observationWrites = [];
  const fileTitle = '北京介绍原生文件验收';
  const specification = { schemaVersion: 1, kind: 'docx', title: fileTitle, paragraphs: [
    { text: '本文件用于核对普通办公任务的真实原生文件生成与领取链。' },
    { text: '主题：北京。文字为受控协议素材，不作为已完成调研或内容质量的证明。' },
  ] };
  let generated;
  const providerErrors = [];
  let schemaObservationIndex = 0;
  const writeSchemaObservation = requestNumber => {
    const name = `ordinary-office-live-schemas-${++schemaObservationIndex}-request-${requestNumber}.json`;
    const snapshot = structuredClone(schemaObservations);
    const write = context.writeArtifactJson(name, snapshot).catch(error => { providerErrors.push(`ARTIFACT_OBSERVER_${error.code || 'FAILED'}`); });
    observationWrites.push(write);
  };
  const model = await startApprovalModelFixture(context, { responseSteps: ({ requestNumber, body }) => {
    try {
      assert.ok(requestNumber <= 3, 'Bounded loopback protocol request budget exceeded');
      assert.ok(JSON.stringify(body.messages).includes(requestText), 'The actual Engine request must contain the exact user request');
      if (fileProof) {
        const direct = (body.tools || []).map(value => value.function || value).find(value => value.name === 'OfficeDocument');
        if (requestNumber === 1) {
          schemaObservations.push({ requestNumber, route: 'actual initial tool names', names: (body.tools || []).map(value => (value.function || value).name) });
          writeSchemaObservation(requestNumber);
        }
        const result = toolResult(body, documentCall);
        if (result) {
          const text = typeof result.text === 'string' ? result.text : JSON.stringify(result);
          schemaObservations.push({ requestNumber, route: 'actual OfficeDocument result', keys: Object.keys(result), bytes: Buffer.byteLength(text),
            sha256: createHash('sha256').update(text).digest('hex'), codes: [...new Set(text.match(/\b(?:OFFICE|NATIVE|TOOL|RUNTIME)_[A-Z0-9_]+\b/g) || [])],
            ...(Buffer.byteLength(text) <= 4096 && !/(?:[a-z][a-z0-9+.-]*:\/\/|Bearer |sk-[A-Za-z0-9_-]{20,}|-----BEGIN)/i.test(text) ? { ownedExactText: text } : {}) });
          writeSchemaObservation(requestNumber);
          assert.equal(result.format, 'docx'); assert.ok(result.artifactRef?.id); assert.match(result.sha256, /^[a-f0-9]{64}$/); generated = result;
        } else if (requestNumber === 1 && direct) {
          expectedRequests = 2;
          schemaObservations.push({ requestNumber, route: 'actual directly exposed schema', names: body.tools.map(value => (value.function || value).name), schema: direct.parameters || direct.input_schema });
          writeSchemaObservation(requestNumber);
          return toolSteps(documentCall, 'OfficeDocument', { specification, sourceRefs: [] });
        } else if (toolResult(body, discoveryCall)) {
          const discovery = toolResult(body, discoveryCall);
          const text = typeof discovery.text === 'string' ? discovery.text : JSON.stringify(discovery);
          const observation = { requestNumber, route: 'actual search response', keys: Object.keys(discovery), bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'),
            codes: [...new Set(text.match(/\b(?:OFFICE|NATIVE|TOOL|RUNTIME)_[A-Z0-9_]+\b/g) || [])],
            names: [...new Set(text.match(/Office(?:Read|Document|Data|Card|Export)/g) || [])] };
          if (Buffer.byteLength(text) <= 4096 && !/(?:https?:\/\/|Bearer |sk-[A-Za-z0-9_-]{20,}|-----BEGIN)/.test(text)) observation.ownedExactText = text;
          schemaObservations.push(observation); writeSchemaObservation(requestNumber);
          let available = Array.isArray(discovery.tools) && discovery.tools.some(value => value.name === 'OfficeDocument');
          for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
            try { const value = JSON.parse(match[1]);
              available ||= value.tools?.some(item => item.name === 'OfficeDocument') === true;
              available ||= text.includes('OfficeDocument') && value.type === 'object' && Boolean(value.properties?.specification);
            } catch { /* Only actual machine-readable schemas count as discovery. */ }
          }
          assert.ok(available, 'Actual OfficeDocument schema was not supplied by the registered search result');
          return toolSteps(documentCall, 'tool_execute', { tool_name: 'OfficeDocument', arguments: { specification, sourceRefs: [] } });
        } else return toolSteps(discoveryCall, 'tool_search', { query: 'OfficeDocument', limit: 1 });
      }
      return [{ delta: { role: 'assistant', content: 'OFFICE_REQUEST_ONLY_PROTOCOL_COMPLETE' } }, { finishReason: 'stop' }];
    } catch (error) { providerErrors.push(String(error.message)); throw error; }
  } });
  const user = await createNativeSystemdUser(context, { baseDirectory: '/tmp' });
  const fixture = await nativeOfficeFixture(context, binary, user.account, model.baseUrl);
  fixture.activeManagers.add('office-request-original-owner');
  context.addCleanup('confirm original Office user manager before removing its fixture', async () => {
    await user.close(); fixture.activeManagers.delete('office-request-original-owner');
  });
  const gateway = await startGateway(context, { label: 'office-request-gateway', workspace: fixture.workspace,
    serversFile: fixture.serversFile, kcoderBin: fixture.binary, uid: fixture.uid, gid: fixture.gid,
    env: fixture.env, auth: true, startTimeoutMs: 60_000 });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', acceptDownloads: true });
  context.addCleanup('close owned Office request page', () => page.close());
  const pageErrors = [];
  const adoptions = [];
  const catalogs = [];
  const taskStates = [];
  const artifactRequests = [];
  const exportReplies = [];
  const methods = [];
  const approvalRequests = [];
  const approvedIds = new Set();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (!frame.method) return;
        methods.push(frame.method);
        if (frame.method === 'integrations/artifact/list') artifactRequests.push(frame.params);
        if (['integrations/assistant/list', 'integrations/assistant/adopt', 'integrations/artifact/export'].includes(frame.method)) pending.set(String(frame.id), { method: frame.method, params: frame.params });
      } catch { /* Non-JSON frames are outside this protocol observation. */ }
    });
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.method === 'approval/request') { approvalRequests.push({ id: frame.id, ...frame.params }); return; }
        if (frame.method === 'integrations/runtime/taskStateChanged') { taskStates.push(frame.params); return; }
        const original = pending.get(String(frame.id));
        if (!original) return;
        pending.delete(String(frame.id));
        if (original.method === 'integrations/artifact/export') exportReplies.push(frame.result);
        else (original.method.endsWith('/adopt') ? adoptions : catalogs).push({ request: original.params, reply: frame.result, error: frame.error });
      } catch { /* Never retain raw socket payloads or authentication material. */ }
    });
  });
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await enableNativeOfficeInPage(context, page, gateway.baseUrl);
    const office = page.getByTestId('native-office-workspace');
    const prompt = office.getByTestId('office-task-request');
    await prompt.waitFor({ timeout: 30_000 });
    assert.equal(await office.getByTestId('office-specialist-templates').getAttribute('open'), null);
    assert.equal(await office.getByTestId('office-task-input-form').locator('input:not([type="file"]):visible, select:visible').count(), 0, 'The default task must not require schema or language fields');
    assert.equal(adoptions.length, 0);
    assert.equal(model.requests.length, 0, 'Opening the page and checking components must not start a model turn');
    assert.ok(!methods.some(method => method === 'thread/start' || method === 'turn/start'));
    await office.getByTestId('office-task-input-form').screenshot({ path: context.pathInArtifacts('ordinary-office-request-empty.png') });
    await prompt.fill(requestText);
    await office.getByTestId('office-task-start').click();
    await waitFor(() => adoptions.length === 1, 30_000, 'the original public Office adopt receipt', 20, context.abortSignal);
    const adoption = adoptions[0];
    assert.equal(adoption.error, undefined);
    assert.ok(['accepted', 'completed'].includes(adoption.reply?.status), adoption.reply?.error?.code);
    const ordinary = catalogs.flatMap(item => item.reply?.result?.items || []).find(item => item.definition?.id === 'builtin.office-task');
    assert.ok(ordinary?.version, 'The actual catalog must supply the ordinary immutable assistant version');
    assert.equal(adoption.request.payload.id, ordinary.definition.id);
    assert.equal(adoption.request.payload.version, ordinary.version);
    assert.equal(adoption.request.payload.inputs.request, submittedRequest);
    assert.deepEqual(Object.keys(adoption.request.payload.inputs).sort(), ['outputLanguage', 'request']);
    const accepted = adoption.reply.result.nativeTask;
    assert.ok(typeof accepted?.threadId === 'string' && accepted.threadId.length > 0);
    assert.ok(accepted.turnId || accepted.taskId);
    await context.writeArtifactJson('ordinary-office-native-accepted.json', { nativeSha256: fixture.imageSha256, operationId: adoption.request.operationId,
      assistantId: ordinary.definition.id, version: ordinary.version, acceptance: accepted, externalModelCalls: 0, fileProof, wholeCasePassed: false });
    await waitFor(async () => {
      if (model.requests.length >= expectedRequests || providerErrors.length > 0) return true;
      const original = approvalRequests.find(value => !approvedIds.has(value.id));
      if (!original) return false;
      assert.equal(original.threadId, accepted.threadId);
      assert.equal(original.turnId, accepted.turnId);
      assert.equal(original.action?.type, 'tool');
      const name = original.action.name;
      assert.ok(['tool_search', 'tool_execute', 'OfficeDocument'].includes(name), 'Only the fixed owned local file scene may receive UI approval');
      assert.deepEqual(original.action.input, name === 'tool_search' ? { query: 'OfficeDocument', limit: 1 }
        : name === 'tool_execute' ? { tool_name: 'OfficeDocument', arguments: { specification, sourceRefs: [] } }
          : { specification, sourceRefs: [] });
      const card = office.getByTestId('task-pending-interactions').getByTestId('request-user-input-card')
        .filter({ has: page.getByTestId('permission-approval-content') }).filter({ hasText: name });
      if (!await card.isVisible()) return false;
      const allow = card.locator('[data-testid^="request-user-input-option-"]').filter({ hasText: /Allow once|仅允许这一次/ });
      assert.equal(await allow.count(), 1);
      approvedIds.add(original.id);
      await allow.click();
      return false;
    }, 45_000, 'actual accepted Engine requests and exact original Ask approvals', 50, context.abortSignal);
    assert.deepEqual(providerErrors, []);
    await waitFor(() => model.requestOutcomes[expectedRequests - 1]?.closed, 10_000, 'the original controlled Provider response to close', 20, context.abortSignal);
    assert.deepEqual(providerErrors, []);
    const terminal = await waitFor(() => taskStates.find(value => value.operationId === adoption.request.operationId
      && value.reference?.threadId === accepted.threadId && ['completed', 'failed', 'cancelled'].includes(value.state)),
      90_000, 'the original canonical native task terminal observation', 20, context.abortSignal);
    assert.equal(terminal.state, 'completed', JSON.stringify(terminal));
    await context.writeArtifactJson('ordinary-office-native-terminal.json', { operationId: adoption.request.operationId, terminal,
      nativeSha256: fixture.imageSha256, controlledProviderRequests: model.requests.length, externalModelCalls: 0, fileProduced: Boolean(generated), approvalCount: approvedIds.size, wholeCasePassed: false });
    assert.equal(adoptions.length, 1);
    assert.equal(model.requests.length, expectedRequests);
    assert.ok(!methods.includes('integrations/office/input/prepare'), 'No material is fabricated for a request-only task');
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: context.pathInArtifacts('ordinary-office-request-accepted.png'), fullPage: true });
    let fileReceipt;
    if (fileProof) {
      assert.ok(generated, 'The actual Native OfficeDocument receipt must reach the next Provider request');
      await page.goto(`${gateway.baseUrl}/office`, { waitUntil: 'domcontentloaded' });
      await office.getByTestId('office-section-artifacts').click();
      const select = office.getByTestId('office-task-select');
      await waitFor(async () => await select.locator('option').count() === 2, 30_000, 'one actual accepted task in the owned profile', 50, context.abortSignal);
      const value = await select.locator('option').nth(1).getAttribute('value');
      assert.ok(value); await select.selectOption(value);
      const row = office.locator('li[data-office-kind="document"]').filter({ has: page.getByRole('heading', { name: fileTitle, exact: true }) });
      await row.waitFor({ timeout: 30_000 });
      assert.ok(artifactRequests.some(value => value.payload?.threadId === accepted.threadId), 'The UI must read the original accepted task');
      const downloadPromise = page.waitForEvent('download', { timeout: 45_000 });
      await row.getByRole('button', { name: /下载|Download/i }).click();
      const download = await downloadPromise;
      const saved = context.pathInArtifacts('ordinary-office-actual.docx'); await download.saveAs(saved);
      assert.equal(await download.failure(), null);
      await waitFor(() => exportReplies.length === 1, 10_000, 'the original native export receipt', 20, context.abortSignal);
      fileReceipt = exportReplies[0]?.result?.export;
      assert.equal(exportReplies[0]?.status, 'completed');
      assert.equal(fileReceipt?.reference?.id, generated.artifactRef.id);
      assert.equal(fileReceipt?.sha256, generated.sha256);
      const bytes = await readFile(saved); assert.deepEqual(Array.from(bytes.subarray(0, 2)), [80, 75]);
      assert.equal(bytes.length, fileReceipt.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), fileReceipt.sha256);
      assert.equal(model.requests.length, expectedRequests, 'Reading or downloading the original file cannot start a model turn');
      await context.writeArtifactJson('ordinary-office-actual-file.json', { artifactRef: generated.artifactRef, task: accepted, export: fileReceipt,
        bytes: bytes.length, sha256: fileReceipt.sha256, actualNodeGeneration: true, harnessReceivedFullBytes: true,
        browserState: 'download_requested; not a native disk-save/reader-quality claim', externalModelCalls: 0 });
    }

    await context.writeArtifactJson('ordinary-office-request-only.json', {
      actualNativeUid: fixture.uid, nativeSha256: fixture.imageSha256, authenticatedGateway: true,
      assistantId: ordinary.definition.id, catalogVersion: ordinary.version,
      operationId: adoption.request.operationId, acceptance: accepted, terminal,
      requestSha256: createHash('sha256').update(requestText).digest('hex'), submittedRequestSha256: createHash('sha256').update(submittedRequest).digest('hex'), submittedInputFields: Object.keys(adoption.request.payload.inputs).sort(),
      originalUiApprovals: approvalRequests.map(value => ({ requestId: value.id, threadId: value.threadId, turnId: value.turnId, tool: value.action?.name, inputSha256: createHash('sha256').update(JSON.stringify(value.action?.input)).digest('hex'), allowOnceClicked: approvedIds.has(value.id) })),
      adoptions: adoptions.length, controlledLoopbackProviderRequests: model.requests.length, externalModelCalls: 0, fileProof, fileReceipt,
      limits: ['Deterministic request admission and Engine protocol; no live-model content quality.', 'The optional file proof checks real generation and complete received bytes, not native disk save or reader rendering.'],
    });
    await page.close();
    await context.stopOwned('office-request-gateway');
    await user.close(); fixture.activeManagers.delete('office-request-original-owner');
    return { requestOnlyAdoption: true, originalEngineRequestObserved: true, materialReferencesInvented: false, controlledLoopbackProviderRequests: expectedRequests, externalModelCalls: 0, actualFileGeneratedAndReceived: Boolean(fileReceipt) };
  } catch (error) {
    await context.writeArtifactJson('ordinary-office-request-failure.json', { error: String(error.message), providerErrors, pageErrors,
      approvals: approvalRequests.map(value => ({ requestId: value.id, threadId: value.threadId, turnId: value.turnId, tool: value.action?.name, allowOnceClicked: approvedIds.has(value.id) })),
      methods, taskStates, schemaObservations, adoptions: adoptions.map(item => ({ status: item.reply?.status, errorCode: item.reply?.error?.code ?? item.error?.code })), controlledLoopbackProviderRequests: model.requests.length });
    await page.screenshot({ path: context.pathInArtifacts('ordinary-office-request-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await Promise.allSettled(observationWrites); }
});
