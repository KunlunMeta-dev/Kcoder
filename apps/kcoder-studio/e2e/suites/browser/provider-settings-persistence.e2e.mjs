import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "provider-settings-ui-persistence-and-sensitive-value-boundary",
    tier: "full-integration",
    modelPolicy:
      "model-independent HTTP/SSE validation and configuration persistence; no agent tools or model-quality assertions",
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "provider-settings",
    });
    const upstream = await startApprovalModelFixture(context, {textOnly:true});
    const rejected = await startApprovalModelFixture(context, {httpErrorPrompt:'Reply only OK.',httpErrorStatus:401,httpErrorMessage:'rejected key'});
    // Keep the runtime's established settings.json filename; this is not an overlay.
    await context.writeStateJson("provider-home/settings.json", {
      active_provider: "fixture-existing",
      model: "MiniMax-M3",
      providers: {
        "fixture-existing": {
          api_format: "openai_chat_completions",
          endpoint: upstream.baseUrl,
          default_model: "fixture-original",
          context_window_tokens: 32000,
          max_output_tokens: 4096,
          output_headroom_tokens: 4096,
        },
      },
    });
    const sensitiveValue = `e2e-synthetic-${randomBytes(20).toString("hex")}`;
    context.registerSecret(sensitiveValue);
    await context.writeStateJson("provider-home/credentials.json", {
      "fixture-existing": { type: "api", key: sensitiveValue },
    });
    const gateway = await startGateway(context, {
      label: "provider-settings-gateway",
      workspace,
      auth: true,
      env: {
        KCODER_CONFIG_DIR: context.pathInState("provider-home"),
      },
    });
    const chromium = await startChromium(context, {
      label: "provider-settings-chromium",
    });
    const primaryContext = await chromium.browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    context.addCleanup("close primary provider settings context", () =>
      primaryContext.close(),
    );
    const page = await primaryContext.newPage();
    const diagnostics = [];
    let responseExposedSensitiveValue = false;
    let submittedTurns = 0;
    page.on("pageerror", (error) => diagnostics.push(error.message));
    page.on("websocket", (socket) => {
      socket.on('framesent', ({ payload }) => {
        try { if (JSON.parse(String(payload)).method === 'turn/start') submittedTurns += 1; } catch {}
      });
      socket.on("framereceived", ({ payload }) => {
        if (String(payload).includes(sensitiveValue))
          responseExposedSensitiveValue = true;
      });
    });

    try {
      await login(page, gateway);
      await openSettings(page, gateway);
      const catalog = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('local_executor_request', {method:'runtime.models.list',params:{}}));
      assert.equal(catalog.data.find(item => item.providerId === 'fixture-existing').model, 'fixture-original');
      await page.locator('[data-testid^="provider-edit-fixture-existing"]').click();
      assert.equal(
        await page.getByTestId("provider-id").inputValue(),
        "fixture-existing",
      );
      assert.equal(
        await page.getByTestId("provider-model").inputValue(),
        "fixture-original",
      );
      assert.equal(await page.getByTestId("provider-apiKey").inputValue(), "");
      await page.getByTestId("provider-model").fill("fixture-edited");
      await page.getByTestId("provider-capability-vision").uncheck();
      // Model-independent boundary: JSON validation, persistence and actual outbound body.
      await page.getByTestId("provider-extra-body").fill('[]');
      const beforeInvalidBody = upstream.requests.length;
      await page.getByTestId("provider-save").click();
      await page.getByText(/额外请求体必须|Extra request body must/).waitFor();
      assert.equal(upstream.requests.length, beforeInvalidBody);
      const beforeRejectedBodies = await snapshotTargetFiles(context);
      for (const field of ["model", "messages", "input", "system", "instructions", "tools", "stream"]) {
        await page.getByTestId("provider-extra-body").fill(JSON.stringify({ [field]: false }));
        await page.getByTestId("provider-save").click();
        await page.getByText(`额外请求体不能覆盖由运行时管理的字段 ${field}`, { exact: false }).waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'provider-extra-body');
        const fieldBox = await page.getByTestId("provider-extra-body").boundingBox();
        assert.ok(fieldBox && fieldBox.y >= 0 && fieldBox.y + fieldBox.height <= 900, "the invalid field must be visible for correction");
        assert.equal(upstream.requests.length, beforeInvalidBody, "reserved input must not reach the model");
        assert.deepEqual(await snapshotTargetFiles(context), beforeRejectedBodies, "rejected input must preserve settings and credentials");
      }
      await page.getByTestId("provider-extra-body").fill(JSON.stringify({ vendor: "x".repeat(65536) }));
      await page.getByTestId("provider-save").click();
      await page.getByText(/额外请求体必须|Extra request body must/).waitFor();
      assert.equal(upstream.requests.length, beforeInvalidBody);
      assert.deepEqual(await snapshotTargetFiles(context), beforeRejectedBodies);
      const extraBody = { thinking: { type: "adaptive" }, reasoning_split: true };
      await page.getByTestId("provider-extra-body").fill(JSON.stringify(extraBody));
      await saveProfile(page, "fixture-existing", "fixture-edited");
      assert.deepEqual(upstream.requests.at(-1).thinking, extraBody.thinking);
      assert.equal(upstream.requests.at(-1).reasoning_split, true);
      await page.locator('[data-testid^="provider-edit-fixture-existing"]').click();
      assert.deepEqual(JSON.parse(await page.getByTestId("provider-extra-body").inputValue()), extraBody);
      await page.getByTestId("provider-extra-body").fill('');
      await saveProfile(page, "fixture-existing", "fixture-edited");
      assert.equal(upstream.requests.at(-1).thinking, undefined);
      assert.equal(upstream.requests.at(-1).reasoning_split, undefined);

      // M05: two isolated browser clients hold the same editor revision.
      const conflictContext = await chromium.browser.newContext({ viewport: { width: 1280, height: 900 } });
      context.addCleanup("close conflicting provider editor", () => conflictContext.close());
      const conflictPage = await conflictContext.newPage();
      await login(conflictPage, gateway);
      await openSettings(conflictPage, gateway);
      await conflictPage.locator('[data-testid^="provider-edit-fixture-existing"]').click();
      await conflictPage.getByTestId("provider-maxOutputTokens").fill("2000");
      await page.getByTestId("provider-maxOutputTokens").fill("3000");
      await saveProfile(page, "fixture-existing", "fixture-edited");
      const winnerFiles = await snapshotTargetFiles(context);
      const winnerRequests = upstream.requests.length;
      await conflictPage.getByTestId("provider-save").click();
      await conflictPage.getByText(/你的草稿已保留/).waitFor();
      assert.equal(await conflictPage.getByTestId("provider-maxOutputTokens").inputValue(), "2000");
      assert.deepEqual(await snapshotTargetFiles(context), winnerFiles);
      assert.equal(upstream.requests.length, winnerRequests, "stale editor must be rejected before probe");
      await conflictPage.getByTestId("provider-refresh").click();
      await waitFor(() => conflictPage.getByTestId("provider-save").isEnabled(), 30000, "refresh completes");
      await conflictPage.getByTestId("provider-save").click();
      await conflictPage.getByText(/你的草稿已保留/).waitFor();
      assert.equal(upstream.requests.length, winnerRequests, "list refresh must not silently rebase the draft");
      await conflictPage.locator('[data-testid^="provider-edit-fixture-existing"]').click();
      assert.equal(await conflictPage.getByTestId("provider-maxOutputTokens").inputValue(), "3000");
      await conflictPage.getByTestId("provider-maxOutputTokens").fill("2000");
      await saveProfile(conflictPage, "fixture-existing", "fixture-edited");
      assert.equal(upstream.requests.length, winnerRequests + 1);
      await conflictContext.close();
      await page.getByTestId("provider-refresh").click();
      await waitFor(() => page.getByTestId("provider-save").isEnabled(), 30000, "primary refresh completes");

      const editedCapabilities = await providerRequest(page, "runtime.providers.list");
      assert.equal(editedCapabilities.profiles.find(profile => profile.id === "fixture-existing").capabilities.vision, false);

      // QA: template prefill is inert; an explicit model and a successful request
      // are required before an unauthenticated deployment becomes persistent.
      await page.getByTestId("provider-new").click();
      const beforeTemplate = await snapshotTargetFiles(context);
      await page.getByTestId("provider-template").selectOption("local-openai");
      assert.equal(await page.getByTestId("provider-model").inputValue(), "");
      assert.equal(await page.getByTestId("provider-endpoint").inputValue(), "http://127.0.0.1:8000/v1");
      assert.equal(await page.getByTestId("provider-apiKey").isDisabled(), true);
      assert.deepEqual(await snapshotTargetFiles(context), beforeTemplate);
      await page.getByTestId("provider-endpoint").fill(upstream.baseUrl);
      const requestsBeforeEmptyModel = upstream.requests.length;
      await page.getByTestId("provider-save").click();
      assert.equal(await page.getByTestId("provider-model").evaluate(node => node.validity.valid), false);
      assert.equal(upstream.requests.length, requestsBeforeEmptyModel);
      assert.deepEqual(await snapshotTargetFiles(context), beforeTemplate);
      await page.getByTestId("provider-model").fill("fixture-local-model");
      await page.getByTestId("provider-default").uncheck();
      await saveProfile(page, "local-openai", "fixture-local-model");
      const withLocal = await providerRequest(page, "runtime.providers.list");
      const localProfile = withLocal.profiles.find(profile => profile.id === "local-openai");
      assert.equal(localProfile.authentication.mode, "none");
      assert.equal(localProfile.apiKeyConfigured, false);
      const localCredentials = JSON.parse(await readFile(context.pathInState("provider-home/credentials.json"), "utf8"));
      assert.equal(Object.hasOwn(localCredentials, "local-openai"), false);
      await confirmDeletion(page, "local-openai");

      await page.getByTestId("provider-new").click();
      await page.getByTestId("provider-id").fill("fixture-added");
      await page
        .getByTestId("provider-endpoint")
        .fill("https://example.invalid/v1?invalid=1");
      await page.getByTestId("provider-model").fill("fixture-added-model");
      await page.getByTestId("provider-apiKey").fill(sensitiveValue);
      assert.equal(
        await page.getByTestId("provider-apiKey").getAttribute("type"),
        "password",
      );
      await page.getByTestId("provider-save").click();
      await page
        .getByRole("alert")
        .waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(
        await page.locator('[data-testid^="provider-edit-fixture-added"]').count(),
        0,
      );
      await assertSensitiveValueAbsent(page, sensitiveValue, false);

      const settingsBefore = createHash('sha256').update(await readFile(context.pathInState('provider-home/settings.json'))).digest('hex');
      const credentialsBefore = createHash('sha256').update(await readFile(context.pathInState('provider-home/credentials.json'))).digest('hex');
      await page.getByTestId('provider-endpoint').fill(rejected.baseUrl);
      await page.getByTestId('provider-save').click();
      await page.getByRole('alert').filter({hasText:'认证失败'}).waitFor({timeout:30000});
      assert.equal(createHash('sha256').update(await readFile(context.pathInState('provider-home/settings.json'))).digest('hex'),settingsBefore);
      assert.equal(createHash('sha256').update(await readFile(context.pathInState('provider-home/credentials.json'))).digest('hex'),credentialsBefore);
      assert.equal(await page.getByTestId('provider-edit-fixture-added').count(),0);
      assert.equal(rejected.requests[0].model,'fixture-added-model');

      await page
        .getByTestId("provider-endpoint")
        .fill(upstream.baseUrl);
      await saveProfile(page, "fixture-added", "fixture-added-model");
      await assertSensitiveValueAbsent(page, sensitiveValue);
      await page.locator('[data-testid^="provider-edit-fixture-added"]').click();
      assert.equal(await page.getByTestId("provider-apiKey").inputValue(), "");
      assert.equal(
        await page.getByTestId("provider-default").isChecked(),
        true,
      );
      await page.getByTestId("provider-model").fill("fixture-added-updated");
      await saveProfile(page, "fixture-added", "fixture-added-updated");
      await assertConfigured(page);

      await page.getByTestId("provider-session-reload").waitFor({ state: "visible" });
      await waitFor(
        async () => {
          const alert = page.getByRole("alert");
          if (await alert.count())
            throw new Error(
              `Provider apply rejected: ${await alert.innerText()}`,
            );
          return (await page.getByTestId("provider-apply").count()) === 0;
        },
        30_000,
        "provider configuration available without restart",
        100,
        context.abortSignal,
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await assertPersisted(page, upstream.baseUrl);
      await assertSensitiveValueAbsent(page, sensitiveValue);

      const secondaryContext = await chromium.browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      context.addCleanup("close secondary provider settings context", () =>
        secondaryContext.close(),
      );
      const secondary = await secondaryContext.newPage();
      await secondary.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        window.__providerSettingsSockets = new Set();
        // Observe real transports so this test can explicitly release its own broker owners.
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) {
            super(...args);
            window.__providerSettingsSockets.add(this);
            this.addEventListener("close", () => window.__providerSettingsSockets.delete(this));
          }
        };
      });
      try {
        await login(secondary, gateway);
      } catch (error) {
        await context.writeArtifactJson("secondary-login-diagnostics.json", {
          path: new URL(secondary.url()).pathname,
          text: await secondary.locator("body").innerText(),
        });
        await secondary.screenshot({
          path: context.pathInArtifacts("secondary-login-failed.png"),
          mask: [secondary.locator('input[type="password"], input[name="token"]')],
        });
        throw error;
      }
      await openSettings(secondary, gateway);
      await assertPersisted(secondary, upstream.baseUrl);
      await assertSensitiveValueAbsent(secondary, sensitiveValue);
      await verifyDeletion(page, secondary, context, sensitiveValue, upstream.baseUrl);
      await secondaryContext.close();

      assert.equal(
        responseExposedSensitiveValue,
        false,
        "RPC responses must not expose submitted sensitive values",
      );
      assert.deepEqual(diagnostics, []);
      // Retain one critical success screenshot after confirming the secret is absent.
      await page.screenshot({
        path: context.pathInArtifacts("provider-settings-deleted.png"),
        fullPage: true,
      });
      // Saving must not invoke Electron's native JS dialog or lose composer focus.
      let nativeDialogs = 0;
      page.on("dialog", async dialog => { nativeDialogs += 1; await dialog.dismiss(); });
      await page.locator('[data-testid^="provider-edit-fixture-existing"]').click();
      // Trailing-dot localhost exercises the existing confirmation policy while keeping all requests on loopback.
      await page.getByTestId("provider-endpoint").fill(upstream.baseUrl.replace("127.0.0.1", "localhost."));
      await page.getByTestId("provider-save").click();
      await page.getByTestId("provider-plaintext-dialog").waitFor();
      await page.getByTestId("provider-plaintext-dialog-close").click();
      await page.getByTestId("provider-save").click();
      await page.getByTestId("provider-plaintext-dialog-confirm").click();
      await waitFor(() => page.getByTestId("provider-save").isEnabled(), 30000, "save returns control to the renderer");
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(nativeDialogs, 0);
      await page.getByTestId("settings-back-button").click();
      const composer = page.getByTestId("chat-message-input");
      await composer.waitFor({ state: "visible" });
      await composer.click();
      await page.keyboard.insertText("focus-after-model-save");
      assert.match(await composer.innerText(), /focus-after-model-save/);
      assert.equal(await composer.evaluate(element => element === document.activeElement || element.contains(document.activeElement)), true);
      // Exercise Chromium's input composition pipeline, not synthetic DOM events.
      // This supplements, but does not claim, physical Windows IME candidate testing.
      const cdp = await primaryContext.newCDPSession(page);
      await composer.press('ControlOrMeta+A');
      await composer.press('Backspace');
      const turnsBeforeComposition = submittedTurns;
      const messagesBeforeComposition = await page.getByTestId('message-user').count();
      await cdp.send('Input.imeSetComposition', { text: '中文输入', selectionStart: 4, selectionEnd: 4 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      assert.equal(submittedTurns, turnsBeforeComposition, 'composition Enter must not submit a turn');
      await cdp.send('Input.insertText', { text: '中文输入' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(submittedTurns, turnsBeforeComposition);
      assert.equal(await page.getByTestId('message-user').count(), messagesBeforeComposition);
      assert.match(await composer.innerText(), /中文输入/);
      assert.equal(await composer.evaluate(element => element === document.activeElement || element.contains(document.activeElement)), true);
      await cdp.detach();
      await page.screenshot({ path: context.pathInArtifacts("composer-focus-after-model-save.png") });
      return {
        composerFocusAfterModelSave: true,
        chromiumCompositionEnterDoesNotSubmit: true,
        noNativeJavascriptDialog: true,
        existingProfileEdited: true,
        explicitCapabilitiesPersisted: true,
        templatePrefillRequiresExplicitModel: true,
        localTemplateFlowVerified: true,
        addedProfilePersisted: true,
        invalidEndpointRejectedAndRecovered: true,
        blankSensitiveInputPreservesConfiguredStatus: true,
        sensitiveValueAbsentFromResponsesAndClientStorage: true,
        newSessionsReloadWithoutRestart: true,
        reloadRestored: true,
        independentClientRestored: true,
        deletionCancelPreservesTarget: true,
        deletionRequiresConfirmationAndSupportsAutomaticReplacement: true,
        deletionCleanupOptInVerified: true,
        secondClientDoesNotBlockNewSessionReload: true,
        deletedProfilesStayAbsentOnIndependentRead: true,
        successScreenshotReason:
          "critical API deletion, persistence and non-disclosure flow",
      };
    } catch (error) {
      await context.writeArtifactJson("provider-settings-diagnostics.json", {
        diagnostics,
        responseExposedSensitiveValue,
        path: new URL(page.url()).pathname,
        error: String(error),
      });
      if (!(await page.locator("body").innerText()).includes(sensitiveValue)) {
        await page
          .screenshot({
            path: context.pathInArtifacts("provider-settings-failed.png"),
            mask: [page.locator('input[type="password"], input[name="token"]')],
            fullPage: true,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  },
);

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page
    .getByTestId("desktop-sidebar")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function openSettings(page, gateway) {
  await page.goto(`${gateway.baseUrl}/settings/personal/models`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByTestId("provider-form")
    .waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(
    () => page.getByTestId("provider-save").isEnabled(),
    30_000,
    "provider settings ready",
  );
}

async function saveProfile(page, id, model) {
  await page.getByTestId("provider-save").click();
  await waitFor(
    async () => {
      const alert = page.getByRole("alert");
      if (await alert.count())
        throw new Error(`Provider save rejected: ${await alert.innerText()}`);
      const row = page.locator(`[data-testid^="provider-edit-${id}"]`);
      return (
        (await row.count()) > 0 &&
        (await row.innerText()).includes(model) &&
        (await row.isEnabled())
      );
    },
    30_000,
    "saved provider profile",
  );
}

async function assertConfigured(page) {
  assert.match(
    await page.locator('[data-testid^="provider-edit-fixture-added"]').innerText(),
    /已配置|Configured/i,
  );
}

async function assertPersisted(page, endpoint) {
  await page
    .locator('[data-testid^="provider-edit-fixture-added"]')
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.match(
    await page.locator('[data-testid^="provider-edit-fixture-existing"]').innerText(),
    /fixture-edited/,
  );
  assert.match(
    await page.locator('[data-testid^="provider-edit-fixture-added"]').innerText(),
    /fixture-added-updated/,
  );
  await assertConfigured(page);
  await page.locator('[data-testid^="provider-edit-fixture-added"]').click();
  assert.equal(
    await page.getByTestId("provider-endpoint").inputValue(),
    endpoint,
  );
  assert.equal(await page.getByTestId("provider-default").isChecked(), true);
  assert.equal(await page.getByTestId("provider-apply").count(), 0);
}

async function assertSensitiveValueAbsent(page, value, inputCleared = true) {
  assert.equal((await page.locator("body").innerText()).includes(value), false);
  if (inputCleared)
    assert.equal(await page.getByTestId("provider-apiKey").inputValue(), "");
  assert.equal(
    await page.evaluate((sensitive) => {
      for (const storage of [localStorage, sessionStorage]) {
        for (let index = 0; index < storage.length; index += 1) {
          if (storage.getItem(storage.key(index)).includes(sensitive))
            return true;
        }
      }
      return false;
    }, value),
    false,
  );
}

async function providerRequest(page, method, params = {}) {
  const serverId = await page.getByTestId("provider-target").inputValue();
  return page.evaluate(({ serverId, method, params }) =>
    window.__TAURI_INTERNALS__.invoke("local_executor_request", {
      method: "runtime.providers.request", params: { serverId, method, params },
    }), { serverId, method, params });
}

async function snapshotTargetFiles(context) {
  const result = {};
  for (const name of ["settings.json", "credentials.json"]) {
    const content = await readFile(context.pathInState(`provider-home/${name}`));
    result[name] = createHash("sha256").update(content).digest("hex");
  }
  return result;
}

async function assertProfileAbsentOnRepeatedReads(page, id) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await providerRequest(page, "runtime.providers.list");
    assert.equal(result.profiles.some(profile => profile.id === id), false, "deleted API must not reappear from the startup snapshot");
    assert.equal(result.profiles.find(profile => profile.id === "fixture-existing")?.isDefault, true);
  }
  assert.equal(await page.locator(`[data-testid^="provider-edit-${id}"]`).count(), 0);
}

async function applySavedProfiles(page, context) {
  await page.getByTestId("provider-session-reload").waitFor({ state: "visible" });
  await waitFor(async () => {
    if (await page.getByRole("alert").count()) throw new Error("Provider deletion apply was rejected");
    return (await page.getByTestId("provider-apply").count()) === 0;
  }, 30000, "apply API deletion using a validated default replacement", 100, context.abortSignal);
}

async function confirmDeletion(page, id, { replacement, removeCredentials = false } = {}) {
  await page.getByTestId(`provider-delete-${id}`).click();
  assert.equal(await page.getByTestId("provider-delete-credentials").isChecked(), false);
  if (replacement) await page.getByTestId("provider-delete-replacement").selectOption(replacement);
  if (removeCredentials) await page.getByTestId("provider-delete-credentials").check();
  await page.getByTestId("provider-delete-dialog-confirm").click();
  await page.getByTestId("provider-delete-dialog").waitFor({ state: "hidden", timeout: 30000 });
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(await page.locator(`[data-testid^="provider-edit-${id}"]`).count(), 0);
}

async function verifyDeletion(page, secondary, context, sensitiveValue, endpoint) {
  const settingsUrl = page.url();
  const disconnectSecondary = async () => {
    const detached = await secondary.evaluate(async () => {
      const sockets = [...window.__providerSettingsSockets].filter(socket => socket.readyState === WebSocket.OPEN);
      await Promise.all(sockets.map((socket, index) => new Promise((resolve, reject) => {
        const id = `provider-settings-detach-${Date.now()}-${index}`;
        const finish = error => {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
          if (error) reject(error);
          else { socket.close(); resolve(); }
        };
        const receive = event => {
          let response;
          try { response = JSON.parse(event.data); } catch { return; }
          if (response.id !== id) return;
          finish(response.result?.detached === true ? null : new Error("Broker refused explicit secondary-client detach"));
        };
        const timer = setTimeout(() => finish(new Error("Secondary-client detach acknowledgement timed out")), 5000);
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "gateway/client/detach", params: { confirm: true, force: false } }));
      })));
      return sockets.length;
    });
    assert.ok(detached > 0, "secondary-client broker detach must be acknowledged before apply");
    await secondary.goto("about:blank");
  };
  // QA: cancel and rejected direct requests must preserve both target files. Deleting a
  // default can select a remaining user-owned API; credential cleanup stays opt-in.
  const before = await snapshotTargetFiles(context);
  for (const params of [
    { id: "fixture-added", confirm: false, replacementProvider: "fixture-existing" },
    { id: "fixture-added", replacementProvider: "fixture-existing" },
  ]) {
    let rejected = false;
    try { await providerRequest(page, "runtime.providers.delete", params); }
    catch { rejected = true; }
    assert.equal(rejected, true, "target must reject missing consent");
  }
  await page.getByTestId("provider-delete-fixture-added").click();
  assert.equal(await page.getByTestId("provider-delete-dialog-confirm").isDisabled(), false);
  await page.getByTestId("provider-delete-replacement").selectOption("fixture-existing");
  await page.getByTestId("provider-delete-credentials").check();
  await page.getByTestId("provider-delete-dialog-close").click();
  assert.deepEqual(await snapshotTargetFiles(context), before);
  assert.equal(await page.locator('[data-testid^="provider-edit-fixture-added"]').count(), 1);

  await confirmDeletion(page, "fixture-added", { replacement: "fixture-existing" });
  const saved = JSON.parse(await readFile(context.pathInState("provider-home/settings.json"), "utf8"));
  assert.equal(Object.hasOwn(saved.providers, "fixture-added"), false);
  assert.equal(saved.active_provider, "fixture-existing");
  assert.equal(await page.getByTestId("provider-apply").count(), 0, "deletion must not require explicit apply");
  await assertProfileAbsentOnRepeatedReads(page, "fixture-added");
  let credentials = JSON.parse(await readFile(context.pathInState("provider-home/credentials.json"), "utf8"));
  assert.equal(credentials["fixture-added"]?.key === sensitiveValue, true, "unchecked credentials remain in the target store");
  // Other clients do not block configuration changes for future conversations.
  assert.equal(await page.getByTestId("provider-apply").count(), 0);
  await secondary.getByTestId("provider-refresh").click();
  await secondary.locator('[data-testid^="provider-edit-fixture-added"]').waitFor({ state: "detached" });
  await assertProfileAbsentOnRepeatedReads(secondary, "fixture-added");
  await disconnectSecondary();
  await applySavedProfiles(page, context);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-testid^="provider-edit-fixture-existing"]').waitFor({ timeout: 30000 });
  await assertProfileAbsentOnRepeatedReads(page, "fixture-added");
  await secondary.goto(settingsUrl, { waitUntil: "domcontentloaded" });
  try {
    await secondary.locator('[data-testid^="provider-edit-fixture-existing"]').waitFor({ timeout: 30000 });
  } catch (error) {
    await context.writeArtifactJson('secondary-reconnect-diagnostic.json', {
      path:new URL(secondary.url()).pathname,
      body:(await secondary.locator('body').innerText()).slice(0,8000),
    });
    await secondary.screenshot({path:context.pathInArtifacts('secondary-reconnect-failed.png'),mask:[secondary.locator('input[type="password"], input[name="token"]')]});
    throw error;
  }
  await assertProfileAbsentOnRepeatedReads(secondary, "fixture-added");
  await disconnectSecondary();

  // Recreate the same non-default profile without sending a key: the retained credential
  // must be usable, and a subsequent explicit cleanup must remove it without touching backup.
  await page.getByTestId("provider-new").click();
  await page.getByTestId("provider-id").fill("fixture-added");
  await page.getByTestId("provider-endpoint").fill(endpoint);
  await page.getByTestId("provider-model").fill("fixture-recreated");
  await page.getByTestId("provider-default").uncheck();
  await saveProfile(page, "fixture-added", "fixture-recreated");
  await assertConfigured(page);
  await applySavedProfiles(page, context);
  await confirmDeletion(page, "fixture-added", { removeCredentials: true });
  credentials = JSON.parse(await readFile(context.pathInState("provider-home/credentials.json"), "utf8"));
  assert.deepEqual(credentials['fixture-added'], { type: 'revoked' },
    'credential removal must retain a revocation marker rather than revive a lower-priority key');
  assert.equal(credentials["fixture-existing"]?.key === sensitiveValue, true, "unrelated default credentials must be preserved");
  await assertProfileAbsentOnRepeatedReads(page, "fixture-added");
  await applySavedProfiles(page, context);
  for (const client of [page, secondary]) {
    await client.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await client.locator('[data-testid^="provider-edit-fixture-existing"]').waitFor({ timeout: 30000 });
    await assertProfileAbsentOnRepeatedReads(client, "fixture-added");
    await assertSensitiveValueAbsent(client, sensitiveValue);
    assert.equal(await client.getByTestId("provider-apply").count(), 0);
  }
}
