import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { startSshFixture } from "../../harness/ssh-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "runtime-target-settings-real-ssh-create-test-edit-delete",
  tier: "full-integration",
  modelPolicy: "no model turn; real Gateway configuration persistence and loopback SSH app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const settingsFile = await context.writeStateJson("runtime-settings.json", {});
  const remoteConfigDir = context.pathInState("remote-config");
  await mkdir(remoteConfigDir, { recursive: true });
  await context.writeStateJson("remote-config/settings.json", {});
  await context.writeStateJson("remote-config/credentials.json", {});
  const remoteCommand = context.pathInState("kcoder-isolated");
  await writeFile(remoteCommand, [
    "#!/bin/sh",
    `export KCODER_CONFIG_DIR='${shellQuote(remoteConfigDir)}'`,
    `exec '${shellQuote(resolve(repoRoot, "target/debug/kcoder"))}' \"$@\"`,
    "",
  ].join("\n"));
  await chmod(remoteCommand, 0o700);
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Local",
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
    settingsFile,
  }]);
  const serversStore = context.pathInState("servers-store.json");
  const ssh = await startSshFixture(context);
  const gateway = await startGateway(context, {
    label: "runtime-target-settings-gateway",
    workspace,
    serversFile,
    serversStore,
    auth: true,
    env: ssh.gatewayEnv,
  });
  const chromium = await startChromium(context, { label: "runtime-target-settings-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const diagnostics = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.stack || error.message}`));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", request => {
    diagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`);
  });

  await login(page, gateway);
  await page.goto(`${gateway.baseUrl}/settings/kcoder-servers`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("runtime-target-list").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("runtime-target-add").click();
  await page.getByTestId("runtime-target-label").fill("Loopback SSH Initial");
  await page.getByTestId("runtime-target-id").fill("settings-ssh-e2e");
  await page.getByTestId("runtime-target-transport").selectOption("ssh");
  await page.getByTestId("runtime-target-host").fill("127.0.0.1");
  await page.getByTestId("runtime-target-workspace").fill(workspace);
  await page.getByTestId("runtime-target-advanced-toggle").click();
  await page.getByTestId("runtime-target-user").fill(ssh.user);
  await page.getByTestId("runtime-target-port").fill(String(ssh.port));
  await page.getByTestId("runtime-target-command").fill(remoteCommand);
  await page.getByTestId("runtime-target-settings-file").fill(settingsFile);
  await page.getByTestId("runtime-target-accept-host-key").check();

  await page.getByTestId("runtime-target-test").click();
  await page.getByRole("status").filter({ hasText: "连接成功" })
    .waitFor({ state: "visible", timeout: 30_000 });
  await shot(page, context, "connection-tested.png");

  await page.getByTestId("runtime-target-save").click();
  const row = page.getByTestId("runtime-target-row-settings-ssh-e2e");
  await row.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await row.innerText(), /Loopback SSH Initial/);
  let apiServers = await page.evaluate(async () => (await fetch("/api/servers")).json());
  assert.equal(apiServers.servers.find(server => server.id === "settings-ssh-e2e")?.acceptNewHostKey, true);
  assert.equal(apiServers.servers.find(server => server.id === "settings-ssh-e2e")?.workspacePath, workspace);
  let stored = JSON.parse(await readFile(serversStore, "utf8"));
  assert.equal(stored.find(server => server.id === "settings-ssh-e2e")?.label, "Loopback SSH Initial");
  assert.equal(stored.find(server => server.id === "settings-ssh-e2e")?.workspace, workspace);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("runtime-target-row-settings-ssh-e2e")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("runtime-target-edit-settings-ssh-e2e").click();
  assert.equal(await page.getByTestId("runtime-target-id").isDisabled(), true);
  await page.getByTestId("runtime-target-label").fill("Loopback SSH Renamed");
  await page.getByTestId("runtime-target-advanced-toggle").click();
  await page.getByTestId("runtime-target-accept-host-key").uncheck();
  await page.getByTestId("runtime-target-save").click();
  const renamed = page.getByTestId("runtime-target-row-settings-ssh-e2e");
  await renamed.filter({ hasText: "Loopback SSH Renamed" })
    .waitFor({ state: "visible", timeout: 30_000 });
  apiServers = await page.evaluate(async () => (await fetch("/api/servers")).json());
  assert.equal(apiServers.servers.find(server => server.id === "settings-ssh-e2e")?.acceptNewHostKey, false);
  stored = JSON.parse(await readFile(serversStore, "utf8"));
  assert.equal(stored.find(server => server.id === "settings-ssh-e2e")?.label, "Loopback SSH Renamed");

  await page.getByTestId("runtime-target-delete-settings-ssh-e2e").click();
  await page.getByTestId("runtime-target-delete-dialog").waitFor({ state: "visible" });
  await page.getByTestId("runtime-target-delete-dialog-confirm").click();
  await renamed.waitFor({ state: "detached", timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.getByTestId("runtime-target-row-settings-ssh-e2e").count(), 0);
  apiServers = await page.evaluate(async () => (await fetch("/api/servers")).json());
  assert.equal(apiServers.servers.some(server => server.id === "settings-ssh-e2e"), false);
  stored = JSON.parse(await readFile(serversStore, "utf8"));
  assert.equal(stored.some(server => server.id === "settings-ssh-e2e"), false);
  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("runtime-target-settings-crud.json", {
    connectionTested: true,
    createPersisted: true,
    reloadRestored: true,
    editPersisted: true,
    deletePersisted: true,
    diagnostics,
  });
  return {
    realLoopbackSsh: true,
    create: true,
    testConnection: true,
    reload: true,
    edit: true,
    delete: true,
  };
});

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 20_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
}

async function shot(page, context, name) {
  await page.screenshot({
    path: context.pathInCase("system-chromium", "runtime-target-settings", name),
    fullPage: true,
  });
}

function shellQuote(value) {
  return value.replaceAll("'", "'\\''");
}
