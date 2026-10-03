import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";
import { startSshFixture } from "../../harness/ssh-fixture.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, { testId: "mobile-web-real-server-editor-create-edit-reload-delete", tier: "full-integration", modelPolicy: "model-independent real Gateway configuration lifecycle", retainSuccessLogs: true }, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const remoteConfigDir = context.pathInState("remote-config");
  await mkdir(remoteConfigDir, { recursive: true });
  await context.writeStateJson("remote-config/settings.json", {});
  await context.writeStateJson("remote-config/credentials.json", {});
  const remoteCommand = context.pathInState("kcoder-isolated");
  await writeFile(remoteCommand, [
    "#!/bin/sh",
    `export KCODER_CONFIG_DIR='${shellQuote(remoteConfigDir)}'`,
    `exec '${shellQuote(resolve(repoRoot, "target/debug/kcoder"))}' "$@"`,
    "",
  ].join("\n"));
  await chmod(remoteCommand, 0o700);
  const settingsFile = await context.writeStateJson("remote-settings.json", {});
  const serversStore = context.pathInState("servers-store.json");
  const ssh = await startSshFixture(context);
  const gateway = await startGateway(context, { auth: true, label: "mobile-server-editor-gateway", workspace, serversStore, env: { ...ssh.gatewayEnv, KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist } });
  const chromium = await startChromium(context, { label: "mobile-server-editor-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`); });
  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByTestId("workspace-path").getAttribute("aria-label"), "工作目录");
  await page.getByLabel("返回", { exact: true }).click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("设置", { exact: true }).click();
  await page.getByText("添加连接", { exact: true }).click();
  const requiredFieldLabels = ["显示名称", "SSH 主机", "用户", "端口", "远端工作目录", "KCoder 命令", "Settings file（可选）"];
  const fieldAccessibility = await Promise.all(requiredFieldLabels.map(async label => ({
    label,
    ariaLabel: await page.getByLabel(label, { exact: true }).getAttribute("aria-label"),
    ariaLabelledBy: await page.getByLabel(label, { exact: true }).getAttribute("aria-labelledby"),
  })));
  if (fieldAccessibility.some(field => !field.ariaLabel && !field.ariaLabelledBy)) {
    await context.writeArtifactJson("mobile-real-server-editor-field-a11y-failure.json", { fieldAccessibility });
  }
  assert.equal(fieldAccessibility.every(field => field.ariaLabel || field.ariaLabelledBy), true,
    "共享 Field 的可见标签必须成为输入框 accessible name");
  await page.getByTestId("server-id").fill("ssh-e2e");
  await page.getByLabel("显示名称", { exact: true }).fill("SSH E2E Initial");
  await page.getByLabel("SSH 主机", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("用户", { exact: true }).fill(ssh.user);
  await page.getByLabel("端口", { exact: true }).fill("1");
  await page.getByLabel("远端工作目录", { exact: true }).fill(workspace);
  await page.getByLabel("KCoder 命令", { exact: true }).fill(remoteCommand);
  await page.getByLabel("Settings file（可选）", { exact: true }).fill(settingsFile);
  await page.getByText("测试连接", { exact: true }).click();
  await page.getByText(/服务器连接失败|连接被拒绝/).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("端口", { exact: true }).fill(String(ssh.port));
  await page.getByTestId("server-chromium-no-sandbox").click();
  await page.getByTestId("server-accept-new-host-key").click();
  assert.equal(await page.getByTestId("server-chromium-no-sandbox").getAttribute("aria-checked"), "true");
  assert.equal(await page.getByTestId("server-accept-new-host-key").getAttribute("aria-checked"), "true");
  await page.getByText("测试连接", { exact: true }).click();
  await page.getByText("成功：SSH 与 app-server 握手通过", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("保存", { exact: true }).click();
  await page.getByText("成功：服务器配置已保存", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  let stored = JSON.parse(await readFile(serversStore, "utf8"));
  let saved = stored.find(server => server.id === "ssh-e2e");
  assert.equal(saved.chromiumNoSandbox, true);
  assert.equal(saved.acceptNewHostKey, true);
  assert.equal(saved.port, ssh.port);
  assert.equal(saved.workspace, workspace);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("SSH E2E Initial", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByTestId("server-id").inputValue(), "ssh-e2e");
  assert.equal(await page.getByTestId("server-id").isEditable(), false);
  assert.equal(await page.getByTestId("server-chromium-no-sandbox").getAttribute("aria-checked"), "true");
  assert.equal(await page.getByTestId("server-accept-new-host-key").getAttribute("aria-checked"), "true");
  await page.getByLabel("显示名称", { exact: true }).fill("SSH E2E Renamed");
  await page.getByTestId("server-chromium-no-sandbox").click();
  await page.getByTestId("server-accept-new-host-key").click();
  await page.getByText("保存", { exact: true }).click();
  await page.getByText("成功：配置已保存，旧连接已关闭，请重新打开任务", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  stored = JSON.parse(await readFile(serversStore, "utf8"));
  saved = stored.find(server => server.id === "ssh-e2e");
  assert.equal(saved.chromiumNoSandbox, undefined);
  assert.equal(saved.acceptNewHostKey, undefined);
  await page.getByLabel("返回", { exact: true }).click();
  await page.getByTestId("settings-host-ssh-e2e").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("settings-host-ssh-e2e").click();
  await page.getByTestId("host-details-route").getByText("SSH E2E Renamed", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("编辑 SSH 配置", { exact: true }).click();
  const confirmation = new Promise(resolveDialog => page.once("dialog", async dialog => { await dialog.accept(); resolveDialog(); }));
  await Promise.all([confirmation, page.getByText("删除此服务器", { exact: true }).click()]);
  await page.getByText("成功：服务器已删除", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.getByText("SSH E2E Renamed", { exact: true }).count(), 0);
  await page.getByLabel("返回", { exact: true }).click();
  await page.getByTestId("settings-host-local").waitFor({ state: "visible", timeout: 30_000 });
  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-server-editor-lifecycle.json", { failedConnection: true, realLoopbackSsh: true, securityTogglesPersisted: true, create: true, reload: true, edit: true, hostDetailsProjection: true, delete: true, localPreserved: true, diagnostics });
  return { realGatewayConfiguration: true, failedConnection: true, realLoopbackSsh: true, securityTogglesPersisted: true, create: true, reloadPersistence: true, edit: true, details: true, delete: true };
});

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

function shellQuote(value) {
  return value.replaceAll("'", "'\\''");
}
