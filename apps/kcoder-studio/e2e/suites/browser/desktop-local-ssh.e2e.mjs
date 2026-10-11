import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../../renderer/node_modules/@playwright/test/index.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { startSshFixture } from "../../harness/ssh-fixture.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: "electron-local-and-ssh-targets",
  tier: "full-integration",
  modelPolicy: "model-independent real Electron host, local/SSH handshake and task creation",
  retainSuccessLogs: true,
}, async context => {
  // QA: one isolated desktop opens with local and SSH targets, both become online,
  // and each can create a task in its own workspace. A reload preserves target
  // availability. No user credentials or personal Electron windows are used.
  if (process.platform !== "linux") throw new Error("UNMET_PREREQUISITE: this Xvfb desktop smoke requires Linux");
  if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1") throw new Error("UNMET_PREREQUISITE: explicit isolated VM no-sandbox opt-in required");
  const xvfb = await requireExecutable("/usr/bin/xvfb-run", "Xvfb runner");
  const electron = await requireExecutable(resolve(appRoot, "node_modules/electron/dist/electron"), "Electron");
  const binary = await requireExecutable(resolve(repoRoot, "target/debug/kcoder"), "KCoder");
  const local = await materializeWorkspace(context, "minimal", { instanceId: "desktop-local" });
  const remote = await materializeWorkspace(context, "minimal", { instanceId: "desktop-remote" });
  const profile = context.pathInState("profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await context.writeStateJson("profile/settings.json", {});
  context.registerSecret("desktop-fixture-key");
  await context.writeStateJson("profile/credentials.json", { "desktop-fixture": { type: "api", key: "desktop-fixture-key" } });
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyChunks: ["DESKTOP_LOCAL_REMOTE_REPLY"] });
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "desktop-fixture",
    providers: { "desktop-fixture": { api_format: "openai_chat_completions", endpoint: model.baseUrl,
      default_model: "desktop-fixture", context_window_tokens: 128000, output_headroom_tokens: 8192,
      max_output_tokens: 8192, no_proxy: true } },
  });
  const ssh = await startSshFixture(context);
  const remoteCommand = context.pathInState("remote-kcoder");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(remoteCommand, `#!/bin/sh\nexec env KCODER_CONFIG_DIR=${quote(profile)} ${quote(binary)} "$@"\n`, { mode: 0o700 });
  const serversFile = await context.writeStateJson("servers.json", [
    { id: "local", label: "Desktop Local", transport: "local", command: binary, workspace: local.path, settingsFile },
    { id: "remote", label: "Desktop Remote", transport: "ssh", host: "127.0.0.1", user: ssh.user,
      port: ssh.port, command: remoteCommand, workspace: remote.path, acceptNewHostKey: true, settingsFile },
  ]);
  const userData = context.pathInState("electron-profile");
  let stderr = "";
  const child = context.spawnOwned("electron-local-ssh", xvfb,
    ["-a", "-s", "-screen 0 1440x900x24 -nolisten tcp", electron, "--no-sandbox", "--disable-gpu",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", resolve(appRoot, "desktop/main.mjs")],
    { cwd: appRoot, env: context.isolatedEnvironment({ ...ssh.gatewayEnv,
      KCODER_CONFIG_DIR: profile,
      KCODER_STUDIO_SERVERS_FILE: serversFile, KCODER_STUDIO_WORKSPACE: local.path,
      KCODER_STUDIO_KCODER_BIN: binary, KCODER_STUDIO_DESKTOP_USER_DATA_DIR: userData,
      KCODER_STUDIO_WEB_ROOT: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, "renderer/dist"),
    }) });
  const captureOutput = chunk => { stderr = `${stderr}${chunk}`.slice(-16000); };
  child.stderr.on("data", captureOutput);
  child.stdout.on("data", captureOutput);
  const cdpUrl = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode})`);
    return stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
  }, 30000, "Electron CDP", 100, context.abortSignal);
  context.registerPort("electron-cdp", Number(new URL(cdpUrl).port));
  const browser = await chromium.connectOverCDP(cdpUrl);
  context.addCleanup("close Electron CDP", () => browser.close());
  const page = await waitFor(() => browser.contexts().flatMap(item => item.pages())
    .find(item => item.url().startsWith("http://127.0.0.1:")), 30000, "desktop window", 100, context.abortSignal);
  await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });
  const statuses = await page.evaluate(async () => {
    const response = await fetch("/api/servers/status");
    if (!response.ok) throw new Error(`Target health failed: ${response.status}`);
    return (await response.json()).statuses;
  });
  assert.equal(statuses.length, 2);
  assert.ok(statuses.every(item => item.status === "online"), JSON.stringify(statuses));
  for (const label of ["Desktop Local", "Desktop Remote"]) {
    const project = page.getByTestId("project-item").filter({ hasText: label }).first();
    await project.waitFor({ timeout: 30000 });
    await project.hover();
    await project.getByTestId("project-new-conversation-button").click();
    const composer = page.getByTestId("chat-message-input");
    await composer.waitFor({ timeout: 30000 });
    await composer.click();
    const prompt = `Verify ${label} task routing.`;
    await page.keyboard.insertText(prompt);
    await page.getByTestId("send-message-button").click();
    await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ timeout: 30000 });
    try {
      await page.getByTestId("message-assistant").filter({ hasText: "DESKTOP_LOCAL_REMOTE_REPLY" }).waitFor({ timeout: 30000 });
    } catch (error) {
      await page.screenshot({ path: context.pathInArtifacts(`task-failure-${label.replaceAll(" ", "-")}.png`) });
      throw error;
    }
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("desktop-sidebar").waitFor({ timeout: 30000 });
  await page.screenshot({ path: context.pathInArtifacts("desktop-local-remote.png") });
  await page.close();
  await waitFor(() => child.exitCode !== null, 15000, "desktop graceful quit", 100, context.abortSignal);
  assert.equal(child.exitCode, 0);
  await context.writeArtifactJson("checks.json", { statuses, localAndRemoteTaskCreation: true, reload: true, gracefulQuit: true });
  return { passed: true, host: process.platform, windowsNativeExecution: false };
});
