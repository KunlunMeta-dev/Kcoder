import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

const kcoderBinary = process.env.KCODER_E2E_KCODER_BIN
  ? resolve(process.env.KCODER_E2E_KCODER_BIN)
  : resolve(repoRoot, "target/kcoder-relay/bin/kcoder");

await runE2E(import.meta.url, {
  testId: "mobile-web-real-structured-transcript",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic mixed-tools scenario through real app-server",
  retainSuccessLogs: true,
}, async context => {
  const configuredBackendBefore = await hashExecutableFile(kcoderBinary);
  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-structured-transcript-export",
    outputName: "mobile-web-export",
    dependencyRoot: resolve(repoRoot, "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules"),
  });
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(resolve(workspace, "src"), { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(resolve(workspace, "src/sample.txt"), "sample workspace file\n", "utf8");
  await context.writeStateJson("config/settings.json", {});
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Local",
    transport: "local",
    command: kcoderBinary,
    workspace,
  }]);
  const gateway = await startGateway(context, {
    label: "mobile-structured-transcript-gateway",
    workspace,
    serversFile,
    kcoderBin: kcoderBinary,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
      KCODER_STUDIO_SCENARIO: "mixed-tools",
    },
  });
  const chromium = await startChromium(context, { label: "mobile-structured-transcript-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });

  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("MOBILE_STRUCTURED_TRANSCRIPT");
  await page.getByTestId("create-workspace").click();
  await page.getByText("tui-lab-mixed-tools-final-sentinel", { exact: false })
    .waitFor({ state: "visible", timeout: 60_000 });

  const thinkingToggles = page.locator('[data-testid^="thinking-segment-toggle-"]');
  assert.ok(await thinkingToggles.count() > 0);
  const initialThinkingToggles = await thinkingToggles.all();
  for (const toggle of initialThinkingToggles) {
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  }
  await initialThinkingToggles[0].click();
  assert.equal(await initialThinkingToggles[0].getAttribute("aria-expanded"), "true");
  for (const toggle of initialThinkingToggles.slice(1))
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  for (const toggle of initialThinkingToggles.slice(1)) await toggle.click();
  const finalThinking = page.locator('[data-testid^="ordered-message-segment-thinking-"]')
    .filter({ hasText: "Every mixed-tool result entered context" })
    .last();
  await finalThinking.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await finalThinking.innerText(), /Every mixed-tool result entered context/);
  assert.match(await finalThinking.innerText(), /emit the final long-text tail for scroll validation/);

  const todo = page.getByTestId("todo-card");
  await todo.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await todo.innerText(), /任务清单 · 0\/2/);
  assert.equal(await todo.getByRole("button").getAttribute("aria-expanded"), "false");
  await todo.getByRole("button").click();
  assert.equal(await todo.getByRole("button").getAttribute("aria-expanded"), "true");
  assert.match(await todo.innerText(), /Verify mixed tool folding/);
  assert.match(await todo.innerText(), /Check Alt\+T expansion/);

  const readTool = page.getByTestId("tool-call-tui-lab-mixed-read");
  await readTool.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await readTool.innerText(), /read/);
  assert.match(await readTool.innerText(), /完成/);
  const readToolToggle = page.getByTestId("tool-call-toggle-tui-lab-mixed-read");
  const bashToolToggle = page.getByTestId("tool-call-toggle-tui-lab-mixed-bash");
  assert.equal(await readToolToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await bashToolToggle.getAttribute("aria-expanded"), "false");
  await readToolToggle.click();
  assert.equal(await readToolToggle.getAttribute("aria-expanded"), "true");
  assert.equal(await bashToolToggle.getAttribute("aria-expanded"), "false");
  assert.match(await readTool.innerText(), /输入/);
  assert.match(await readTool.innerText(), /src\/sample\.txt/);
  assert.match(await readTool.innerText(), /输出/);
  assert.match(await readTool.innerText(), /sample workspace file/);

  const bashTool = page.getByTestId("tool-call-tui-lab-mixed-bash");
  await bashTool.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await bashTool.innerText(), /完成/);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("tui-lab-mixed-tools-final-sentinel", { exact: false })
    .waitFor({ state: "visible", timeout: 30_000 });
  const reloadedThinkingToggles = page.locator('[data-testid^="thinking-segment-toggle-"]');
  assert.ok(await reloadedThinkingToggles.count() > 0);
  const persistedThinkingToggles = await reloadedThinkingToggles.all();
  for (const toggle of persistedThinkingToggles)
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await persistedThinkingToggles[0].click();
  assert.equal(await persistedThinkingToggles[0].getAttribute("aria-expanded"), "true");
  for (const toggle of persistedThinkingToggles.slice(1))
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  for (const toggle of persistedThinkingToggles.slice(1)) await toggle.click();
  const reloadedFinalThinking = page.locator('[data-testid^="ordered-message-segment-thinking-"]')
    .filter({ hasText: "Every mixed-tool result entered context" })
    .last();
  await reloadedFinalThinking.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await reloadedFinalThinking.innerText(), /emit the final long-text tail for scroll validation/);
  const reloadedTodo = page.getByTestId("todo-card");
  await reloadedTodo.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await reloadedTodo.innerText(), /任务清单 · 0\/2/);
  await reloadedTodo.getByRole("button").click();
  assert.equal(await reloadedTodo.getByRole("button").getAttribute("aria-expanded"), "true");
  assert.match(await reloadedTodo.innerText(), /Verify mixed tool folding/);
  assert.match(await reloadedTodo.innerText(), /Check Alt\+T expansion/);
  const reloadedReadTool = page.getByTestId("tool-call-tui-lab-mixed-read");
  await reloadedReadTool.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await reloadedReadTool.innerText(), /完成/);
  const reloadedReadToolToggle = page.getByTestId("tool-call-toggle-tui-lab-mixed-read");
  const reloadedBashToolToggle = page.getByTestId("tool-call-toggle-tui-lab-mixed-bash");
  assert.equal(await reloadedReadToolToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await reloadedBashToolToggle.getAttribute("aria-expanded"), "false");
  await reloadedReadToolToggle.click();
  assert.equal(await reloadedReadToolToggle.getAttribute("aria-expanded"), "true");
  assert.match(await reloadedReadTool.innerText(), /src\/sample\.txt/);
  assert.match(await reloadedReadTool.innerText(), /sample workspace file/);
  assert.deepEqual(diagnostics, []);
  const ownedBackendProcesses = await findOwnedExecutableProcesses({
    pgid: gateway.child.pid,
    executablePath: configuredBackendBefore.path,
  });
  const configuredBackendAfter = await hashExecutableFile(kcoderBinary);
  const backendBinaryUnchanged = JSON.stringify(configuredBackendAfter) === JSON.stringify(configuredBackendBefore);
  const actualExecutableVerified = ownedBackendProcesses.some(item => item.sha256 === configuredBackendBefore.sha256);
  const backendProcessProvenance = {
    configuredBefore: configuredBackendBefore,
    configuredAfter: configuredBackendAfter,
    unchanged: backendBinaryUnchanged,
    gatewayProcessGroupId: gateway.child.pid,
    status: actualExecutableVerified ? "verified" : "unverified",
    ownedProcesses: ownedBackendProcesses,
    unverifiedReason: actualExecutableVerified ? null : "no readable matching configured executable found in this run's Gateway process group",
  };
  await context.writeArtifactJson("mobile-backend-binary-provenance.json", backendProcessProvenance);
  assert.equal(backendBinaryUnchanged, true, "configured KCoder backend binary changed during this run");
  await context.writeArtifactJson("mobile-real-structured-transcript.json", {
    mobileWebExport: {
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      bundleSha256: mobileWeb.bundleSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
      bundleManifestPath: mobileWeb.bundleManifestPath,
    },
    backendBinary: backendProcessProvenance,
    thinkingExpanded: true,
    todoExpanded: true,
    completedTools: ["read", "bash"],
    toolInputOutputExpanded: true,
    durableAfterReload: ["thinking", "todo", "tool"],
    diagnostics,
  });
  return {
    thinking: true,
    todos: true,
    tools: true,
    durableAfterReload: true,
    mobileWebExport: {
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      bundleSha256: mobileWeb.bundleSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
      bundleManifestPath: mobileWeb.bundleManifestPath,
    },
    backendBinary: backendProcessProvenance,
  };
});

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}
