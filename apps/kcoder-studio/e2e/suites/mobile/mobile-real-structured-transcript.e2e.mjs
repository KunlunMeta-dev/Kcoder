import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-structured-transcript",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic mixed-tools scenario through real app-server",
  retainSuccessLogs: true,
}, async context => {
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
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
  }]);
  const gateway = await startGateway(context, {
    label: "mobile-structured-transcript-gateway",
    workspace,
    serversFile,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_WEB_ROOT: mobileDist,
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

  const thinking = page.getByTestId("thinking-disclosure").last();
  await thinking.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await thinking.innerText(), /Every mixed-tool result entered context/);
  assert.equal(await thinking.getByRole("button").getAttribute("aria-expanded"), "false");
  await thinking.getByRole("button").click();
  assert.equal(await thinking.getByRole("button").getAttribute("aria-expanded"), "true");

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
  assert.equal(await readTool.getByRole("button").getAttribute("aria-expanded"), "false");
  await readTool.getByRole("button").click();
  assert.equal(await readTool.getByRole("button").getAttribute("aria-expanded"), "true");
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
  const reloadedThinking = page.getByTestId("thinking-disclosure").last();
  await reloadedThinking.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await reloadedThinking.innerText(), /Every mixed-tool result entered context/);
  await reloadedThinking.getByRole("button").click();
  assert.equal(await reloadedThinking.getByRole("button").getAttribute("aria-expanded"), "true");
  assert.match(await reloadedThinking.innerText(), /emit the final long-text tail for scroll validation/);
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
  await reloadedReadTool.getByRole("button").click();
  assert.equal(await reloadedReadTool.getByRole("button").getAttribute("aria-expanded"), "true");
  assert.match(await reloadedReadTool.innerText(), /src\/sample\.txt/);
  assert.match(await reloadedReadTool.innerText(), /sample workspace file/);
  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-structured-transcript.json", {
    thinkingExpanded: true,
    todoExpanded: true,
    completedTools: ["read", "bash"],
    toolInputOutputExpanded: true,
    durableAfterReload: ["thinking", "todo", "tool"],
    diagnostics,
  });
  return { thinking: true, todos: true, tools: true, durableAfterReload: true };
});

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}
