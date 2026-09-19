import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { startSshFixture } from "../../harness/ssh-fixture.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();
await runE2E(
  import.meta.url,
  {
    testId: "provider-template-save-apply-isolated-ssh-target",
    tier: "full-integration",
    modelPolicy:
      "Real loopback SSH and HTTP validation, synthetic settings only; no external model calls",
  },
  async (context) => {
    const { path: localWorkspace } = await materializeWorkspace(
      context,
      "minimal",
      { instanceId: "provider-local" },
    );
    const { path: remoteWorkspace } = await materializeWorkspace(
      context,
      "minimal",
      { instanceId: "provider-ssh" },
    );
    const model = await startApprovalModelFixture(context, { textOnly: true });
    const seed = (id) => ({
      active_provider: id,
      providers: {
        [id]: {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          default_model: id,
          authentication: { mode: "none" },
          context_window_tokens: 128000,
          max_output_tokens: 4096,
          output_headroom_tokens: 4096,
        },
      },
    });
    await context.writeStateJson(
      "local-home/settings.json",
      { active_provider: null, providers: {} },
    );
    await context.writeStateJson("remote-home/settings.json", seed("ssh-seed"));
    const localFile = context.pathInState("local-home/settings.json");
    const remoteFile = context.pathInState("remote-home/settings.json");
    const localBefore = await readFile(localFile, "utf8");
    const remoteBefore = await readFile(remoteFile, "utf8");
    const ssh = await startSshFixture(context, { user: userInfo().username });
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const wrapper = context.pathInState("remote-kcoder");
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        `export HOME=${quote(context.pathInState("remote-home"))}`,
        `export XDG_CONFIG_HOME=${quote(context.pathInState("remote-home"))}`,
        `export KCODER_CONFIG_DIR=${quote(context.pathInState("remote-home"))}`,
        `exec ${quote(resolve(repoRoot, "target/debug/kcoder"))} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o700, flag: "wx" },
    );
    await chmod(wrapper, 0o700);
    const serversFile = context.pathInState("provider-servers.json");
    await context.writeStateJson("provider-servers.json", [
      {
        id: "local",
        label: "Local control",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace: localWorkspace,
      },
      {
        id: "ssh-loopback",
        label: "SSH fixture",
        transport: "ssh",
        host: "127.0.0.1",
        port: ssh.port,
        user: ssh.user,
        command: wrapper,
        workspace: remoteWorkspace,
      },
    ]);
    const gateway = await startGateway(context, {
      workspace: localWorkspace,
      serversFile,
      auth: true,
      env: {
        ...ssh.gatewayEnv,
        KCODER_CONFIG_DIR: context.pathInState("local-home"),
      },
    });
    const chromium = await startChromium(context);
    const browserContext = await chromium.browser.newContext();
    context.addCleanup("close SSH provider browser context", () =>
      browserContext.close(),
    );
    const page = await browserContext.newPage();
    const wireMethods = [];
    page.on('websocket', socket => socket.on('framesent', event => {
      try { const frame = JSON.parse(String(event.payload)); if (frame.method) wireMethods.push(frame.method); } catch {}
    }));
    try {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/login")),
      page.locator('button[type="submit"]').click(),
    ]);
    // QA: local-first registry with no local models, remote-only model, real SSH creation.
    // Catalog selection and provider routing are model-independent assertions.
    await page.getByTestId("desktop-sidebar").waitFor({ timeout: 30000 });
    const rpc = (method, params) => page.evaluate(({ method, params }) =>
      window.__TAURI_INTERNALS__.invoke('local_executor_request', { method, params }),
      { method, params });
    await rpc('runtime.projects.upsert_local', {
      deviceId: 'ssh-loopback', projectKey: 'remote-model-project', name: 'Remote model project', roots: [remoteWorkspace],
    });
    await page.reload();
    const project = () => page.getByTestId('project-item').filter({ hasText: 'Remote model project' }).first();
    await project().getByTestId('project-new-conversation-button').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="model-selector-button"]')?.textContent?.includes('ssh-seed'), null, { timeout: 30000 });
    assert.ok(!(await page.getByTestId('model-selector-button').innerText()).includes('local-seed'));
    await page.getByTestId('chat-message-input').fill('OLD_SESSION_BEFORE_RELOAD');
    await page.getByTestId('send-message-button').click();
    await waitFor(() => model.requests.some(request => request.model === 'ssh-seed'), 30000, 'old conversation uses original model');
    await page.waitForFunction(() => !document.querySelector('[data-testid="pause-response-button"]') && document.querySelector('[data-testid="message-assistant"]'), null, { timeout: 30000 });
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-menu-button').click();
    await page.getByTestId('settings-nav-model-settings').click();
    await waitFor(async () => await page.getByTestId('provider-target').inputValue() === 'ssh-loopback', 10000, 'settings follows active remote project');
    await page
      .locator('[data-testid^="provider-edit-ssh-seed"]')
      .waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-testid^="provider-edit-local-seed"]').count(), 0);
    await page.getByTestId("provider-new").click();
    await page.getByTestId("provider-template").selectOption("local-openai");
    assert.equal(await page.getByTestId("provider-model").inputValue(), "");
    assert.equal(await readFile(remoteFile, "utf8"), remoteBefore);
    await page.getByTestId("provider-endpoint").fill(model.baseUrl);
    await page.getByTestId("provider-model").fill("ssh-fixture-model");
    await page.getByTestId("provider-save").click();
    await waitFor(
      async () => {
        const alert = page.getByRole("alert");
        if (await alert.count()) throw new Error(await alert.innerText());
        return (
          (await page.locator('[data-testid^="provider-edit-local-openai"]').count()) > 0
        );
      },
      30000,
      "SSH provider saved through real validation",
    );
    const saved = JSON.parse(await readFile(remoteFile, "utf8"));
    assert.equal(
      saved.providers["local-openai"].default_model,
      "ssh-fixture-model",
    );
    assert.equal(saved.providers["local-openai"].authentication.mode, "none");
    assert.equal(await readFile(localFile, "utf8"), localBefore);
    assert.ok(
      model.requests.some((request) => request.model === "ssh-fixture-model"),
    );
    await page.getByTestId('provider-session-reload').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('provider-apply').count(), 0, 'new sessions must not require restarting');
    await page.getByTestId("provider-target").selectOption("local");
    await waitFor(async () => !(await page.getByTestId("provider-refresh").isDisabled()), 10000, "empty local target loaded");
    assert.equal(await page.locator('[data-testid^="provider-edit-"]').count(), 0);
    assert.equal(
      await page.locator('[data-testid^="provider-edit-local-openai"]').count(),
      0,
    );
    assert.equal(await readFile(localFile, "utf8"), localBefore);
    await page.getByTestId("provider-target").selectOption("ssh-loopback");
    await page
      .locator('[data-testid^="provider-edit-local-openai"]')
      .waitFor({ state: "visible" });
    assert.match(
      await page.locator('[data-testid^="provider-edit-local-openai"]').innerText(),
      /ssh-fixture-model/,
    );
    await page.getByTestId('settings-back-button').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="model-selector-button"]')?.textContent?.includes('ssh-seed'), null, { timeout: 30000 });
    const beforeFollowup = model.requests.length;
    await page.getByTestId('chat-message-input').fill('OLD_SESSION_AFTER_RELOAD');
    await page.getByTestId('send-message-button').click();
    await waitFor(() => model.requests.length > beforeFollowup, 30000, 'old conversation followup');
    assert.equal(model.requests[beforeFollowup].model, 'ssh-seed');
    await page.waitForFunction(() => !document.querySelector('[data-testid="pause-response-button"]'), null, { timeout: 30000 });
    await project().getByTestId('project-new-conversation-button').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="model-selector-button"]')?.textContent?.includes('ssh-fixture-model'), null, { timeout: 30000 });
    const beforeCreation = model.requests.length;
    const editor = page.getByTestId('chat-message-input');
    await editor.fill('REMOTE_MODEL_ROUTING_CHECK');
    await page.getByTestId('send-message-button').click();
    await waitFor(() => model.requests.slice(beforeCreation).some(request => request.model === 'ssh-fixture-model'), 30000, 'remote default reaches the provider on a new conversation');
    await page.waitForFunction(() => !document.querySelector('[data-testid="pause-response-button"]') && document.querySelector('[data-testid="message-assistant"]'), null, { timeout: 30000 });
    assert.ok(!model.requests.slice(beforeCreation).some(request => request.model === 'local-seed'));
    assert.equal(await readFile(localFile, 'utf8'), localBefore);
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-menu-button').click();
    await page.getByTestId('settings-nav-model-settings').click();
    for (const id of ['local-openai', 'ssh-seed']) {
      await page.getByTestId(`provider-delete-${id}`).click();
      assert.equal(await page.getByTestId('provider-delete-dialog-confirm').isEnabled(), true);
      await page.getByTestId('provider-delete-dialog-confirm').click();
      await page.getByTestId(`provider-delete-${id}`).waitFor({ state: 'detached' });
    }
    const emptyRemote = JSON.parse(await readFile(remoteFile, 'utf8'));
    assert.deepEqual(emptyRemote.providers, {});
    assert.equal(emptyRemote.active_provider, null);
    await waitFor(async () => {
      const alert = page.getByRole('alert');
      if (await alert.count()) throw new Error(await alert.innerText());
      return await page.getByTestId('provider-apply').count() === 0;
    }, 30000, 'last remote API deletion applies to new sessions without restarting');
    assert.equal(await page.locator('[data-testid^="provider-edit-"]').count(), 0);
    assert.equal(await readFile(localFile, 'utf8'), localBefore);
    await page.screenshot({
      path: context.pathInArtifacts("ssh-provider-saved.png"),
    });
    assert.ok(!wireMethods.some(method => /shutdown|restart/.test(method)), 'saving and deleting providers must not restart the app-server');
    return {
      automaticNewSessionReload: true,
      existingConversationKeepsOriginalModel: true,
      realSsh: true,
      validatedSavedForNewSessions: true,
      localSettingsUnchanged: true,
      localHasNoModelConfiguration: true,
      targetSwitchReadBack: true,
      remoteCatalogAndNewConversation: true,
      deleteAllRemoteApisWithoutRestart: true,
      successScreenshotReason: "critical SSH target configuration isolation",
    };
    } catch (error) {
      await page.screenshot({ path: context.pathInArtifacts('failure.png') });
      await context.writeArtifactJson('failure-ui.json', { text: await page.locator('body').innerText() });
      throw error;
    }
  },
);
