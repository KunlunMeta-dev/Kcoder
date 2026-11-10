import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { appRoot } from './run-context.mjs';
import { startChromium } from './chromium.mjs';
import { assertRendererBuildFresh } from './renderer-build.mjs';
import { requireExecutable } from './run-context.mjs';

export async function preflightOriginalRemoteOperationUi() {
  await requireExecutable(process.env.KCODER_E2E_CHROMIUM_BIN || '/usr/bin/chromium', 'owned operation UI Chromium');
  await assertRendererBuildFresh({ sourceRoot: resolve(process.env.KCODER_E2E_GATEWAY_ROOT || appRoot, 'renderer') });
}

/** Observe an operation actually produced by this same RunContext. No task,
 * fixture snapshot, renderer state injection or substitute Gateway is created.
 */
export async function observeOriginalRemoteOperationUi(context, {
  gateway, cookie, workspace, threadId, operationId, artifact, snapshot,
}) {
  assert.equal(snapshot.operationId, operationId);
  assert.equal(snapshot.receiver.status, 'completed');
  assert.equal(snapshot.receiver.terminalConfirmed, true);
  assert.equal(snapshot.artifact.id, artifact.id);
  assert.equal(snapshot.artifact.sha256, artifact.sha256);
  assert.match(operationId, /^remote-[a-f0-9]{64}$/);
  const browser = await startChromium(context, { label: 'original-operation-ui' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const methods = new Set();
  const errors = [];
  const inspect = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (typeof value.method === 'string') methods.add(value.method);
    for (const key of ['params', 'payload', 'args', 'request']) inspect(value[key], depth + 1);
  };
  page.on('websocket', socket => socket.on('framesent', event => {
    try { inspect(JSON.parse(String(event.payload))); } catch { /* Not every frame carries JSON. */ }
  }));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    try { inspect(request.postDataJSON()); } catch { /* Ignore non-JSON UI transport. */ }
  });
  page.on('pageerror', error => { if (errors.length < 20) errors.push(context.redactText(error.message)); });
  const prefix = 'kcoder_studio_session=';
  assert.ok(cookie.startsWith(prefix));
  await page.context().addCookies([{ name: 'kcoder_studio_session', value: cookie.slice(prefix.length),
    url: gateway.baseUrl, httpOnly: true, sameSite: 'Strict' }]);
  try {
    const route = `/runtime-tasks?deviceId=local&taskId=${encodeURIComponent(`kcoder:local:${threadId}`)}`;
    await page.goto(gateway.baseUrl + route, { waitUntil: 'domcontentloaded' });
    await page.getByText('Original material transfer observation complete.', { exact: true }).waitFor({ timeout: 60000 });
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-menu-button').click();
    const link = page.locator('a[href="/settings/kcoder-servers"]');
    if (await link.count()) await link.click();
    else await page.getByRole('button', { name: /^(运行目标|Runtime targets)$/ }).click();
    const selected = page.getByTestId('remote-operation-workspace');
    await selected.waitFor({ timeout: 30000 });
    assert.ok((await selected.innerText()).includes(workspace), 'The normal selected conversation must supply its actual workspace');
    const panel = selected.getByTestId('native-remote-operation');
    await panel.getByRole('button', { name: /^(读取最近十条原操作|Read ten recent original operations)$/ }).click();
    const row = panel.locator(`[data-remote-operation-id="${operationId}"]`);
    await row.waitFor({ timeout: 30000 });
    await row.click();
    const observed = panel.getByTestId('remote-operation-observation');
    await observed.waitFor({ timeout: 30000 });
    const taskStatus = await observed.locator('dl').first().locator('dd').nth(0).innerText();
    assert.match(taskStatus, /^(已完成|Completed)$/);
    const cleanupStatus = await observed.locator('dl').first().locator('dd').nth(1).innerText();
    const cleanupLabels = { confirmed: /^(已确认|Confirmed)$/, unconfirmed: /^(未确认|Unconfirmed)$/,
      not_observed: /^(尚未观察|Not observed)$/ };
    assert.match(cleanupStatus, cleanupLabels[snapshot.cleanup]);
    assert.ok((await observed.innerText()).includes(artifact.id));
    const cancel = observed.getByRole('button', { name: /^(请求取消|Request cancellation)$/ });
    assert.equal(await cancel.isDisabled(), true, 'The known original terminal cannot invite another cancellation');
    await observed.locator('summary').click();
    const details = await observed.innerText();
    assert.ok(details.includes(operationId));
    assert.ok(details.includes(snapshot.receiver.identity.threadId));
    assert.ok(details.includes(artifact.sha256));
    assert.match(details, /传输与阅读记录不代表业务正确|Transport and reader observations do not verify business correctness/);
    await page.screenshot({ path: context.pathInArtifacts('original-ssh-operation-ui-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 480, height: 900 });
    await panel.waitFor({state:'visible'});
    assert.equal(await panel.evaluate(node => node.clientWidth > 0 && node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: context.pathInArtifacts('original-ssh-operation-ui-narrow.png'), fullPage: true });
    assert.ok(methods.has('integrations/remotes/listOperations'), 'The original page must consume the actual list RPC');
    assert.ok(methods.has('integrations/remotes/readOperation'), 'The original page must consume the actual read RPC');
    for (const method of ['turn/start', 'thread/start', 'integrations/remotes/delegate', 'integrations/remotes/cancelOperation'])
      assert.equal(methods.has(method), false, `Read-only inspection cannot issue ${method}`);
    assert.deepEqual(errors, [], 'The original operation view must not raise page errors');
    await context.writeArtifactJson('original-ssh-operation-ui-proof.json', { operationId, sourceThreadId: threadId,
      receiverIdentity: snapshot.receiver.identity, receiverStatus: snapshot.receiver.status,
      artifact: { id: artifact.id, revision: artifact.revision, bytes: artifact.bytes, sha256: artifact.sha256 },
      cleanup: snapshot.cleanup, businessCompleted: false, originalConversation: true, actualReadonlyPage: true,
      methods: [...methods].filter(method => method.startsWith('integrations/remotes/')), pageErrors: errors,
      newTask: false, newDelegation: false });
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('original-ssh-operation-ui-failure.png'), fullPage: true,
      mask: [page.locator('input[name="token"]'), page.locator('input[type="password"]')] }).catch(() => {});
    throw error;
  }
}
