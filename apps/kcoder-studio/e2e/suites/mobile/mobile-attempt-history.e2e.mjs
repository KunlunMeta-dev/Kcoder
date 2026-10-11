import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

const mobileDist = resolve(process.env.KCODER_E2E_MOBILE_WEB_ROOT || resolve(appRoot, 'mobile/dist'));
await access(resolve(mobileDist, 'index.html'));

await runE2E(import.meta.url, {
  testId: 'mobile-preserves-failed-attempt-after-continuation-and-restart', tier: 'full-integration',
  modelPolicy: 'model-independent loopback HTTP failure; actual app-server persistence and Mobile Web UI',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'attempt-mobile' });
  const model = await startApprovalModelFixture(context, { textOnly: true,
    textOnlyResponse: 'ATTEMPT_RECOVERED', httpErrorPrompt: 'ATTEMPT_HISTORY_MOBILE',
    httpErrorStatus: 503, httpErrorMatchLimit: 1 });
  const config = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 128000, output_headroom_tokens: 4096,
      max_output_tokens: 1024, no_proxy: true } } });
  const key = 'synthetic-attempt-history'; context.registerSecret(key);
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
  const gateway = await startGateway(context, { workspace, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_WEB_ROOT: mobileDist } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const connect = async () => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
    context.addCleanup('close attempt history RPC', () => rpc.close());
    await initializeRpc(rpc, 'attempt-history-mobile'); return rpc;
  };
  let rpc = await connect();
  const { thread } = await rpc.request('thread/start', {});
  const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'ATTEMPT_HISTORY_MOBILE' }] });
  const failed = await rpc.waitFor(m => m.method === 'turn/completed' && m.params?.turnId === turn.id, 30000, 'original failure');
  assert.equal(failed.params.turn.status, 'failed');
  const failureDetails = failed.params.error?.details;
  const safeFailureDetails = failureDetails && typeof failureDetails === 'object'
    ? Object.fromEntries(['category', 'recovery_action', 'http_status', 'retryable', 'resume_safe', 'retry_after_ms']
      .filter(key => Object.hasOwn(failureDetails, key))
      .map(key => [key, failureDetails[key]]))
    : null;
  const failureMessage = context.redactText(String(failed.params.error?.message ?? ''))
    .replace(/https?:\/\/[^\s)]+/gi, '[url]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(authorization|api[_ -]?key|token|secret|credential)(\s*[:=]\s*|\s+)[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 400);
  const fixtureRequests = model.requests.map((request, index) => ({
    requestNumber: index + 1,
    model: typeof request.model === 'string' ? request.model : null,
    messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
    includesFailurePrompt: JSON.stringify(request.messages ?? []).includes('ATTEMPT_HISTORY_MOBILE'),
  }));
  await context.writeArtifactJson('failure.metadata.json', {
    turnId: turn.id,
    threadId: thread.id,
    status: failed.params.turn.status,
    errorCode: Number.isInteger(failed.params.error?.code) ? failed.params.error.code : null,
    errorMessage: failureMessage,
    providerFailure: safeFailureDetails,
    mobileWebRoot: mobileDist,
    fixture: {
      requestCount: model.requests.length,
      requests: fixtureRequests,
      outcomes: model.requestOutcomes.map(({ requestNumber, closed, aborted }) => ({ requestNumber, closed, aborted })),
    },
  });
  assert.equal(model.requests.length, 1, 'the original failure must come from the HTTP fixture, not a local preflight');
  assert.ok(JSON.stringify(model.requests[0].messages ?? []).includes('ATTEMPT_HISTORY_MOBILE'),
    'the original test prompt must reach the HTTP fixture');
  assert.equal(safeFailureDetails?.http_status, 503, 'continuation requires the original turn to be an HTTP model failure');
  await rpc.request('turn/start', { threadId: thread.id, retryFromTurnId: turn.id,
    retryOperationId: 'attempt-mobile-recovery', input: [] });
  const recovered = await rpc.waitFor(m => m !== failed && m.method === 'turn/completed' && m.params?.turnId === turn.id, 30000, 'continued completion');
  assert.equal(recovered.params.turn.status, 'completed');
  await rpc.request('thread/metadata/update', { threadId: thread.id, title: 'Attempt history mobile' });
  await rpc.request('gateway/app-server/restart', { confirm: true });
  rpc.close(); rpc = await connect();
  const history = await rpc.request('thread/read', { threadId: thread.id, limit: 50 });
  const prior = history.messages.find(message => message.status === 'failed');
  assert.equal(prior.attemptId, turn.id);
  assert.ok(prior.continuedByAttemptId);
  assert.equal(prior.content, '', 'a failure without body must remain a visible row');
  rpc.close();
  await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 5000, 'seed RPC closure');

  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('welcome-direct-connection').click();
  await page.getByTestId('gateway-endpoint').fill(gateway.baseUrl);
  await page.getByTestId('gateway-connect').click();
  await page.getByTestId('new-workspace').waitFor({ timeout: 30000 });
  await page.getByTestId('sessions').click();
  await page.getByTestId('session-search').fill('Attempt history mobile');
  await page.getByTestId(`session-${thread.id}`).click();
  await page.getByTestId('message-attempt-failure').waitFor({ timeout: 30000 });
  await page.getByText('ATTEMPT_RECOVERED', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('message-attempt-failure').count(), 1);
  assert.ok((await page.getByTestId('message-attempt-failure').innerText()).includes('已从失败处继续'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('message-attempt-failure').waitFor({ timeout: 30000 });
  await page.getByText('ATTEMPT_RECOVERED', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(model.requests.length, 2, 'opening history must not issue model requests');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const header = await page.getByTestId('task-header').boundingBox();
    const title = await page.getByTestId('task-header-title').boundingBox();
    const status = await page.getByTestId('task-header-status').boundingBox();
    assert.ok(header && title && status);
    assert.ok(title.y >= header.y, 'long cwd must not clip the task title');
    assert.ok(status.y + status.height <= header.y + header.height, 'status stays inside header');
    assert.ok(status.height <= 18, 'cwd remains a single line');
    assert.ok(status.x >= 0 && status.x + status.width <= width, 'status fits narrow viewport');
    await page.screenshot({ path: context.pathInArtifacts(`mobile-header-${width}.png`) });
  }
  await page.screenshot({ path: context.pathInArtifacts('mobile-attempt-history.png') });
  return { attemptRows: 1, modelRequests: model.requests.length, restoredAfterProcessRestart: true };
});
