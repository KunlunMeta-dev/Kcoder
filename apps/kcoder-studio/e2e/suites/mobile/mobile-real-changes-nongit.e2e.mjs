import assert from "node:assert/strict";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-real-changes-non-git-review-revert",
    tier: "full-integration",
    modelPolicy: "model-independent deterministic real app-server",
    retainSuccessLogs: true,
  },
  async (context) => {
    const workspace = context.pathInState("plain-workspace");
    const configDir = context.pathInState("config");
    const existingFile = resolve(workspace, "plain.txt");
    const createdFile = resolve(workspace, "created.txt");
    await mkdir(workspace, { recursive: true });
    await writeFile(existingFile, "not a git repository\n");
    // The run directory is under repository target/test; an invalid gitdir prevents Git from discovering the host repository through parent traversal.
    await writeFile(
      resolve(workspace, ".git"),
      "gitdir: /nonexistent/mobile-nongit-e2e\n",
    );
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const model = await startApprovalModelFixture(context, {
      approvalCommand:
        "printf 'changed outside git\\n' > plain.txt && printf 'created outside git\\n' > created.txt",
    });
    const settingsFile = await context.writeStateJson("nongit-settings.json", {
      active_provider: "nongit-mobile",
      permission_mode: "yolo",
      providers: {
        "nongit-mobile": {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          default_model: "nongit-e2e-model",
          context_window_tokens: 128000,
          output_headroom_tokens: 8192,
          max_output_tokens: 8192,
          request_timeout_secs: 30,
          no_proxy: true,
          extra_body: {},
        },
      },
    });
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "nongit-mobile": { type: "api", key: "deterministic-local" },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Local",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-nongit-gateway",
      workspace,
      serversFile,
      env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
    });
    const chromium = await startChromium(context, {
      label: "mobile-nongit-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = {
      pageErrors: [],
      console: [],
      failedResponses: [],
      requestFailures: [],
    };
    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        diagnostics.console.push(`${message.type()}: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        diagnostics.failedResponses.push(
          `${response.status()} ${response.url()}`,
        );
    });
    page.on("requestfailed", (request) =>
      diagnostics.requestFailures.push(
        `${request.failure()?.errorText} ${request.url()}`,
      ),
    );
    await connect(page, gateway);
    const deviceCommands = [];
    page.on("websocket", (socket) =>
      socket.on("framesent", (event) => {
        try {
          const value = JSON.parse(String(event.payload));
          if (value?.method === "device/execute")
            deviceCommands.push(value.params?.command_key);
        } catch {}
      }),
    );
    await createTask(page, "MOBILE_NONGIT_CHANGES");
    await waitFor(() => exists(createdFile), 30_000, "非 Git 回合创建文件");
    await page.getByTestId("workspace-tab-switcher").click();
    await page.getByTestId("workspace-tab-changes").click();
    const alert = page.getByRole("alert");
    try {
      await alert.waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      await context.writeArtifactJson("nongit-failure.json", {
        body: (await page.locator("body").innerText()).slice(-8000),
        diagnostics,
      });
      throw error;
    }
    const firstError = await alert.innerText();
    assert.match(firstError, /git|repository|仓库/i);
    await page.getByLabel("刷新 Git 变更").click();
    await alert.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await alert.innerText(), /git|repository|仓库/i);

    await page.getByTestId("changes-mode-turn").click();
    await page
      .getByLabel("撤销本回合变更")
      .waitFor({ state: "visible", timeout: 30_000 });
    const changesPanel = page.getByTestId("changes-panel");
    await changesPanel
      .getByText("plain.txt", { exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    await changesPanel
      .getByText("created.txt", { exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    await changesPanel.getByText("created.txt", { exact: true }).click();
    await changesPanel
      .getByText(/created outside git/)
      .waitFor({ state: "visible", timeout: 30_000 });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByLabel("撤销本回合变更").click();
    await waitFor(
      async () => !(await exists(createdFile)),
      30_000,
      "非 Git 回合删除创建文件",
    );
    assert.equal(
      await readFile(existingFile, "utf8"),
      "not a git repository\n",
    );
    assert.equal(
      await readFile(resolve(workspace, ".git"), "utf8"),
      "gitdir: /nonexistent/mobile-nongit-e2e\n",
    );
    await page
      .getByText("已撤销", { exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(deviceCommands.includes("turn_file_changes_review"));
    assert.ok(deviceCommands.includes("turn_file_changes_revert"));

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator('[data-testid="workspace-tab-switcher"]:visible')
      .click();
    await page.locator('[data-testid="workspace-tab-changes"]:visible').click();
    await page.locator('[data-testid="changes-mode-turn"]:visible').click();
    await page
      .getByText("已撤销", { exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page.locator('[aria-label="撤销本回合变更"]:visible').count(),
      0,
    );
    assert.deepEqual(await findPrivateGitRepositories(configDir), []);
    assert.deepEqual(diagnostics, {
      pageErrors: [],
      console: [],
      failedResponses: [],
      requestFailures: [],
    });
    await context.writeArtifactJson("mobile-real-changes-nongit.json", {
      workspace,
      firstError,
      deviceCommands,
      diagnostics,
    });
    return {
      realAppServer: true,
      nonGitErrorVisible: true,
      turnArtifactVisible: true,
      filePathsVisible: true,
      revertedOnDisk: true,
      revertedStateSurvivesReload: true,
    };
  },
);

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page
    .getByTestId("new-workspace")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page
    .getByTestId("workspace-path")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page
    .getByTestId("message-user")
    .filter({ hasText: prompt })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByText("权限确认后的命令已执行。", { exact: true })
    .waitFor({ state: "visible", timeout: 60_000 });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`等待 ${label} 超时 (${timeoutMs}ms)`);
}

async function findPrivateGitRepositories(root) {
  const matches = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (
        /^(snapshot|revert)-repository-/.test(entry.name) ||
        /^snapshot-.*\.index$/.test(entry.name)
      ) {
        matches.push(path);
      } else if (entry.isDirectory()) {
        await visit(path);
      }
    }
  };
  await visit(root);
  return matches.sort();
}
