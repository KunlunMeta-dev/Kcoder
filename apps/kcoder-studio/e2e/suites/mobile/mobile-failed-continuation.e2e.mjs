import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Fixed model frames only validate the Mobile continuation protocol/UI and
// actual tool side effects, never the quality or tool choice of a real model.
await runE2E(import.meta.url, { testId: 'mobile-continues-failures-without-repeating-tools', tier: 'full-integration',
  modelPolicy: 'model-independent real Mobile Web, Gateway, persisted attempts and Bash counter' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const prompt = 'MOBILE_CONTINUE_ONCE';
  const modelOptions = {
    sessionApprovalPrompt: prompt, sessionApprovalCount: 1, sessionApprovalCommand: 'printf x >> mobile-once.txt',
    sessionApprovalFinalText: 'MOBILE_CONTINUATION_DONE', httpErrorPrompt: prompt,
    httpErrorAfterToolResults: 1, httpErrorMatchLimit: 2, httpErrorStatus: 503,
  };
  const model = await startApprovalModelFixture(context, modelOptions);
  const settings = { active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      authentication: { mode: 'none' }, default_model: 'fixture', no_proxy: true,
      context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
      models: { fixture: { context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024, extra_body: { temperature: 0.2 } } } } } };
  await context.writeStateJson('profile/settings.json', settings);
  const gateway = await startGateway(context, { workspace, kcoderBin: resolve(repoRoot, 'target/debug/kcoder'),
    env: { KCODER_CONFIG_DIR: context.pathInState('profile'), KCODER_STUDIO_WEB_ROOT: resolve(appRoot, 'mobile/dist') } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close Mobile fixture seed', () => rpc.close()); await initializeRpc(rpc, 'mobile-continuation-seed');
  const { thread } = await rpc.request('thread/start');
  const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
  await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id && message.params.turn.status === 'failed', 30000, 'seed failure after committed tool');
  await rpc.request('thread/metadata/update', { threadId: thread.id, title: 'Mobile continuation fixture' });
  assert.equal(await readFile(resolve(workspace, 'mobile-once.txt'), 'utf8'), 'x'); rpc.close();
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const starts = [];
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const message = JSON.parse(String(frame.payload)); if (message.method === 'turn/start') starts.push(message.params); } catch {}
  }));
  try {
    await page.goto(gateway.baseUrl);
    await page.getByTestId('welcome-direct-connection').click();
    await page.getByTestId('gateway-endpoint').fill(gateway.baseUrl);
    await page.getByTestId('gateway-connect').click();
    await page.getByTestId('new-workspace').waitFor({ timeout: 30000 });
    await page.getByTestId('sessions').click();
    await page.getByTestId('session-search').fill('Mobile continuation fixture');
    await page.getByTestId(`session-${thread.id}`).click();
    await page.getByTestId('failure-recovery-facts').first().getByText('失败阶段：模型请求', { exact: true }).waitFor();
    await page.getByTestId('failure-summary').first().getByText('模型服务返回错误，请查看详情并核实服务状态。', { exact: true }).waitFor();
    await page.getByTestId('failure-technical-details').first().click();
    await page.getByTestId('message-attempt-failure').first().getByText(/HTTP 503/).waitFor();
    await page.getByTestId('failure-technical-details').first().click();
    await page.getByTestId('message-continue-failure').click();
    await waitFor(async () => await page.getByTestId('message-attempt-failure').count() === 2, 30000, 'second failed attempt rendered');
    assert.equal(model.requests.at(-1).temperature, 0.2);
    settings.providers.fixture.models.fixture.extra_body.temperature = 0.7;
    const nextSettings = await context.writeStateJson('profile/next-settings.json', settings);
    await rename(nextSettings, context.pathInState('profile/settings.json'));
    await page.getByTestId('message-continue-selected-model').click();
    await page.getByText('MOBILE_CONTINUATION_DONE', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(starts.length, 2, 'both continuations must originate in Mobile UI');
    assert.ok(starts.every(value => value.retryFromTurnId === turn.id && value.input.length === 0 && value.retryOperationId));
    assert.notEqual(starts[0].retryFromAttemptId, starts[1].retryFromAttemptId);
    assert.equal(model.requests.length, 4);
    assert.equal(model.requests.at(-1).temperature, 0.7);
    assert.equal(starts[1].retryModelConfiguration, 'current');
    assert.equal(await readFile(resolve(workspace, 'mobile-once.txt'), 'utf8'), 'x');
    assert.equal(await page.getByTestId('message-user').count(), 1);
    assert.equal(await page.getByTestId('message-attempt-failure').count(), 2);
    await page.reload();
    await page.getByText('MOBILE_CONTINUATION_DONE', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId('message-attempt-failure').count(), 2);
    assert.equal(await page.getByTestId('message-user').count(), 1);
    assert.equal(model.requests.length, 4);
    await page.screenshot({ path: context.pathInArtifacts('mobile-continuation.png') });
    const profileId = new URL(page.url()).pathname.split('/')[2];
    modelOptions.httpErrorPrompt = 'MOBILE_OLD_CAPABILITY';
    modelOptions.httpErrorAfterToolResults = 0;
    modelOptions.httpErrorMatchLimit = 3;
    const seed = await openRpc(gatewayRpcUrl(gateway, 'local', token));
    context.addCleanup('close old-capability fixture seed', () => seed.close());
    await initializeRpc(seed, 'old-capability-fixture');
    const old = await seed.request('thread/start');
    const rejected = await seed.request('turn/start', { threadId: old.thread.id, input: [{ type: 'text', text: 'MOBILE_OLD_CAPABILITY' }] });
    await seed.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === rejected.turn.id && message.params?.threadId === old.thread.id, 30000, 'legacy target failure');
    await seed.request('thread/metadata/update', { threadId: old.thread.id, title: 'Mobile old capability' });
    seed.close();
    await page.routeWebSocket('**/rpc*', socket => {
      const upstream = socket.connectToServer();
      upstream.onMessage(raw => {
        try {
          const message = JSON.parse(String(raw));
          const capabilities = message.result?.capabilities?.experimental;
          if (capabilities) {
            capabilities.failedTurnContinuationV1 = false;
            capabilities.turnAttemptRetryV1 = false;
            socket.send(JSON.stringify(message)); return;
          }
        } catch {}
        socket.send(raw);
      });
    });
    await page.goto(`${gateway.baseUrl}/sessions?profileId=${encodeURIComponent(profileId)}`);
    await page.getByTestId('session-search').fill('Mobile old capability');
    await page.getByTestId(`session-${old.thread.id}`).click();
    await page.getByTestId('continuation-unavailable').waitFor();
    assert.match(await page.getByTestId('continuation-unavailable').innerText(), /升级/);
    assert.equal(await page.getByTestId('message-continue-failure').isDisabled(), true);
    assert.equal(starts.length, 2, 'old capability must never cause Mobile to resend the prompt');
    assert.equal(model.requests.length, 5);
    await page.screenshot({ path: context.pathInArtifacts('mobile-old-capability.png') });

    return { mobileInitiatedContinuations: 2, failuresRetained: 2, providerRequests: 5, oldCapabilityBlockedWithoutMutation: true, toolExecutions: 1, userMessages: 1, reloadPreservedHistory: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {}); throw error;
  } finally { await page.close(); }
});
