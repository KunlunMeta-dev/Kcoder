import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const execFile = promisify(execFileCallback);
const MODEL = "managed-worktree-e2e-model";

await runE2E(
  import.meta.url,
  {
    testId:
      "workspace-managed-worktree-task-files-terminal-refresh-archive-delete-cleanup",
    tier: "browser-real-app-server",
    modelPolicy:
      "deterministic provider only completes a model-independent workspace-routing turn",
    retainSuccessLogs: true,
  },
  async (context) => {
    const stamp = Date.now();
    const projectName = `managed-worktree-${stamp}`;
    const prompt = `MANAGED_WORKTREE_ROUTE_${stamp}`;
    const branch = "feature/e2e-base";
    const marker = `BRANCH_BASE_${stamp}`;
    const createdFile = "WORKTREE_ONLY.txt";
    const fixture = await materializeWorkspace(context, "minimal", {
      instanceId: "managed-worktree-source",
    });
    const sourceWorkspace = resolve(fixture.path);
    await initRepository(sourceWorkspace, branch, marker);

    const coverageLedger = [
      {
        area: "项目/多根目录/工作区",
        existingRealE2E: ["project-multi-root-target-sync"],
        status: "近期 PASS，转向未覆盖旅程",
      },
      {
        area: "文件树/编辑器",
        existingRealE2E: ["workspace-file-crud"],
        status: "近期 PASS；本轮验证 managed worktree 路由",
      },
      {
        area: "终端",
        existingRealE2E: ["workspace-two-terminal-tabs"],
        status: "近期 PASS；本轮验证 managed worktree cwd",
      },
      {
        area: "Git source control",
        existingRealE2E: ["workspace-git-source-control"],
        status: "近期 PASS；本轮验证真实 git worktree",
      },
      {
        area: "对话/模型/持久化",
        existingRealE2E: ["workspace-conversation-preferences-persistence"],
        status: "近期 PASS；本轮验证任务 workspacePath",
      },
      {
        area: "app-server 中断恢复",
        existingRealE2E: ["workspace-app-server-interruption-recovery"],
        status: "近期 PASS",
      },
      {
        area: "managed worktree 真实执行",
        existingRealE2E: [],
        status: "本轮",
      },
      {
        area: "移动 Web 附件与 changes",
        existingRealE2E: [],
        status: "待后续真实覆盖",
      },
    ];
    const evidence = {
      stage: "setup",
      coverageLedger,
      steps: [],
      paths: [],
      git: [],
      files: [],
      taskLifecycle: [],
      rpcFrames: [],
      ipcCalls: [],
      cleanup: [],
      diagnostics: {
        console: [],
        failedResponses: [],
        requestFailures: [],
        socketErrors: [],
      },
    };

    const configDir = context.pathInState("kcoder-config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("kcoder-config/settings.json", {});
    await context.writeStateJson("kcoder-config/credentials.json", {
      "managed-worktree-e2e": {
        type: "api",
        key: "deterministic-managed-worktree",
      },
    });
    const modelFixture = await startApprovalModelFixture(context, {
      textOnly: true,
    });
    const settingsFile = await context.writeStateJson("kcoder-settings.json", {
      active_provider: "managed-worktree-e2e",
      providers: {
        "managed-worktree-e2e": {
          api_format: "openai_chat_completions",
          endpoint: modelFixture.baseUrl,
          default_model: MODEL,
          context_window_tokens: 128_000,
          output_headroom_tokens: 8_192,
          max_output_tokens: 8_192,
          request_timeout_secs: 30,
          no_proxy: true,
          extra_body: {},
        },
      },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Managed Worktree E2E",
        runtime: "kcoder",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace: sourceWorkspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "managed-worktree-gateway",
      workspace: sourceWorkspace,
      serversFile,
      auth: true,
      env: { KCODER_CONFIG_DIR: configDir },
    });
    const chromium = await startChromium(context, {
      label: "managed-worktree-chromium",
    });
    const browserContext = await chromium.browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    const page = await browserContext.newPage();
    observe(page, evidence);
    let projectId = "";
    let taskId = "";
    let worktreePath = "";
    let worktreeId = "";
    let taskDeleted = false;
    let worktreeDeleted = false;
    let failure;

    try {
      await login(page, gateway);
      await installIpcCapture(page);
      evidence.stage = "create-project";
      projectId = await createProject(page, sourceWorkspace, projectName);
      await selectProject(page, projectId, projectName);

      evidence.stage = "select-worktree-branch";
      await page.getByTestId("execution-mode-button").click();
      await page.getByTestId("execution-mode-git-worktree-button").click();
      await page.getByTestId("project-worktree-branch-button").click();
      const branchOption = page
        .getByTestId("project-worktree-branch-option")
        .filter({ hasText: branch });
      await branchOption.waitFor({ state: "visible", timeout: 30_000 });
      await branchOption.click();
      assert.match(
        await page.getByTestId("execution-mode-button").innerText(),
        /新工作树|worktree/i,
      );
      assert.match(
        await page.getByTestId("project-worktree-branch-button").innerText(),
        new RegExp(escapeRegExp(branch)),
      );
      const projectPreferences = await page.evaluate(() =>
        JSON.parse(
          localStorage.getItem("wework.localUser.preferences") ?? "{}",
        ),
      );
      const workPreference =
        projectPreferences?.wework_project_work_preferences?.[
          `project:${projectId}`
        ];
      assert.equal(workPreference?.executionMode, "git_worktree");
      assert.equal(workPreference?.worktreeBranch, branch);
      evidence.steps.push({
        label: "user-selected-managed-worktree-and-baseline-branch",
        branch,
      });

      evidence.stage = "create-task";
      await sendPrompt(page, prompt);
      taskId = await waitConversation(page, prompt);
      evidence.ipcCalls = await readIpcCapture(page);
      assert.equal(modelFixture.requests.at(-1)?.model, MODEL);
      const backendWorktrees = await rawRuntimeRequest(
        page,
        "runtime.worktrees.list",
        { deviceId: "local" },
      );
      const activeWorktree = (backendWorktrees?.items ?? []).find(
        (item) =>
          item.state === "active" &&
          resolve(item.sourcePath) === sourceWorkspace,
      );
      assert.ok(
        activeWorktree,
        `runtime.worktrees.prepare 未留下 active worktree：${JSON.stringify(backendWorktrees)}`,
      );
      worktreePath = resolve(activeWorktree.path);
      worktreeId = activeWorktree.worktreeId;
      const environmentPath = resolve(await readEnvironmentWorkspacePath(page));
      evidence.paths.push({
        label: "task-environment-versus-backend",
        sourceWorkspace,
        worktreePath,
        environmentPath,
      });
      assert.equal(
        environmentPath,
        worktreePath,
        "任务环境弹层没有投影 runtime.worktrees.prepare 返回的 workspacePath",
      );
      await assertPathExists(worktreePath);
      assert.equal(
        await readFile(resolve(worktreePath, "BRANCH_BASE.txt"), "utf8"),
        `${marker}\n`,
      );
      await assertPathMissing(resolve(sourceWorkspace, "BRANCH_BASE.txt"));
      const initialWorktreeList = await gitWorktreeList(sourceWorkspace);
      assert.ok(
        initialWorktreeList.paths.includes(resolve(worktreePath)),
        initialWorktreeList.raw,
      );
      evidence.git.push({ label: "after-create", ...initialWorktreeList });
      await shot(page, context, "01-managed-task-environment.png");

      evidence.stage = "files-route";
      await openRightFiles(page);
      await waitFileTarget(page, worktreePath);
      await expandTreeRoot(page, worktreePath);
      await waitForTreeItem(page, "BRANCH_BASE.txt");
      evidence.files.push({
        label: "files-root",
        path: worktreePath,
        branchMarkerVisible: true,
      });

      evidence.stage = "terminal-route";
      await addRightTerminal(page);
      const terminalResult = await terminalCreateProbe(
        page,
        worktreePath,
        createdFile,
        stamp,
      );
      evidence.files.push(terminalResult);
      assert.equal(
        await readFile(resolve(worktreePath, createdFile), "utf8"),
        `WORKTREE_${stamp}\n`,
      );
      await assertPathMissing(resolve(sourceWorkspace, createdFile));
      evidence.steps.push({
        label: "files-and-terminal-target-managed-worktree-original-clean",
      });
      await shot(page, context, "02-managed-files-terminal.png");

      // A dedicated journey covers terminal recovery across refresh. This journey
      // explicitly closes the old PTY before refresh and creates another terminal after
      // refresh to validate cwd without two persistent terminals interfering with archival semantics.
      await exitActiveTerminal(page);

      evidence.stage = "refresh-reopen";
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByTestId("desktop-sidebar")
        .waitFor({ state: "visible", timeout: 30_000 });
      await openRuntimeTask(page, projectName, taskId);
      await assertConversation(page, prompt);
      assert.equal(
        resolve(await readEnvironmentWorkspacePath(page)),
        resolve(worktreePath),
      );
      await openRightFiles(page);
      await waitFileTarget(page, worktreePath);
      await addOrSelectRightTerminal(page);
      evidence.files.push(
        await terminalCwdProbe(page, worktreePath, `REFRESH_${stamp}`),
      );
      evidence.steps.push({
        label: "refresh-and-reopen-restored-task-workspace-files-terminal",
        worktreePath,
      });
      await shot(page, context, "03-managed-refresh-reopen.png");

      await exitActiveTerminal(page);
      for (const testId of [
        "right-workspace-terminal-tab-close-button",
        "right-workspace-file-tab-close-button",
      ]) {
        const close = page.getByTestId(testId);
        if (await close.count()) await close.click();
      }

      evidence.stage = "archive-task-without-reclaiming-worktree";
      await archiveTask(page, projectName, taskId);
      const archivedBeforeNavigation = await waitForArchivedTask(page, taskId);
      evidence.ipcCalls = await readIpcCapture(page);
      evidence.taskLifecycle.push({
        label: "archived",
        taskId,
        response: archivedBeforeNavigation,
      });
      const afterArchive = await rawRuntimeRequest(
        page,
        "runtime.worktrees.list",
        { deviceId: "local" },
      );
      const archivedWorktree = (afterArchive?.items ?? []).find(
        (item) => resolve(item.path) === resolve(worktreePath),
      );
      assert.equal(
        archivedWorktree?.state,
        "active",
        "归档单个任务不得隐式回收可能共享的 worktree",
      );
      await assertPathExists(worktreePath);
      assert.ok(
        (await gitWorktreeList(sourceWorkspace)).paths.includes(
          resolve(worktreePath),
        ),
      );
      evidence.taskLifecycle.push({
        label: "task-archive-leaves-managed-worktree-active",
        worktreeState: archivedWorktree?.state,
      });
      await page.goto(`${gateway.baseUrl}/settings/archived-conversations`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .getByTestId("archived-conversations-settings-page")
        .waitFor({ state: "visible", timeout: 30_000 });
      evidence.taskLifecycle.push({
        label: "runtime-discovery-after-navigation",
        worktrees: await rawRuntimeRequest(page, "runtime.worktrees.list", {
          deviceId: "local",
        }),
        tasks: await rawRuntimeRequest(page, "runtime.tasks.list", {}),
      });
      const archivedAfterNavigation = await waitForArchivedTask(page, taskId);
      evidence.taskLifecycle.push({
        label: "archived-after-navigation",
        taskId,
        response: archivedAfterNavigation,
      });
      const suffix = sanitizeTestId(`local-${taskId}`);
      const archivedItem = page.getByTestId(`archived-item-${suffix}`);
      await archivedItem.waitFor({ state: "visible", timeout: 30_000 });
      await page.getByTestId(`archived-delete-button-${suffix}`).click();
      await page
        .getByTestId("archived-delete-confirm-dialog-confirm-button")
        .click();
      await archivedItem.waitFor({ state: "detached", timeout: 30_000 });
      taskDeleted = true;
      evidence.taskLifecycle.push({ label: "permanently-deleted", taskId });

      evidence.stage = "observe-worktree-after-task-delete";
      const afterTaskDelete = await rawRuntimeRequest(
        page,
        "runtime.worktrees.list",
        { deviceId: "local" },
      );
      const remaining = (afterTaskDelete?.items ?? []).find(
        (item) => resolve(item.path) === resolve(worktreePath),
      );
      assert.ok(
        remaining,
        "永久删除归档会话前恢复的托管工作树应继续存在，等待用户显式清理",
      );
      assert.equal(remaining.state, "active");
      assert.equal(
        await readFile(resolve(worktreePath, createdFile), "utf8"),
        `WORKTREE_${stamp}\n`,
      );
      evidence.taskLifecycle.push({
        label: "permanent-delete-restores-snapshot-before-thread-delete",
        worktreeState: remaining.state,
        linkedConversations: remaining.conversations?.length ?? null,
      });
      assert.ok(
        (await gitWorktreeList(sourceWorkspace)).paths.includes(
          resolve(worktreePath),
        ),
      );

      evidence.stage = "settings-safe-worktree-lifecycle";
      await page.goto(`${gateway.baseUrl}/settings/worktrees`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .getByTestId("worktrees-settings-page")
        .waitFor({ state: "visible", timeout: 30_000 });
      const row = page
        .getByTestId("worktree-row")
        .filter({ hasText: worktreePath });
      await row.waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(
        await row.getByTestId("worktree-linked-task").count(),
        0,
        "永久删除会话后工作树不应继续显示失效会话链接",
      );
      await shot(page, context, "04-worktree-survives-task-delete.png");
      await page.getByTestId(`archive-worktree-button-${worktreeId}`).click();
      await page
        .getByTestId("archive-worktree-dialog")
        .waitFor({ state: "visible", timeout: 30_000 });
      await page.getByTestId("confirm-archive-worktree-button").click();
      await page
        .getByTestId(`restore-worktree-button-${worktreeId}`)
        .waitFor({ state: "visible", timeout: 60_000 });
      await assertPathMissing(worktreePath);
      const afterExplicitDelete = await rawRuntimeRequest(
        page,
        "runtime.worktrees.list",
        { deviceId: "local" },
      );
      const restorable = (afterExplicitDelete?.items ?? []).find(
        (item) => resolve(item.path) === resolve(worktreePath),
      );
      assert.equal(
        restorable?.state,
        "restorable",
        "设置页归档应保留可恢复快照状态",
      );
      const finalWorktreeList = await gitWorktreeList(sourceWorkspace);
      assert.equal(
        finalWorktreeList.paths.includes(resolve(worktreePath)),
        false,
        finalWorktreeList.raw,
      );
      evidence.git.push({
        label: "after-explicit-settings-archive",
        ...finalWorktreeList,
        storedState: restorable?.state,
      });

      await page.getByTestId(`restore-worktree-button-${worktreeId}`).click();
      await page
        .getByTestId(`archive-worktree-button-${worktreeId}`)
        .waitFor({ state: "visible", timeout: 60_000 });
      assert.equal(
        await readFile(resolve(worktreePath, createdFile), "utf8"),
        `WORKTREE_${stamp}\n`,
      );
      await page.getByTestId(`archive-worktree-button-${worktreeId}`).click();
      await page
        .getByTestId("archive-worktree-dialog")
        .waitFor({ state: "visible", timeout: 30_000 });
      await page.getByTestId("confirm-archive-worktree-button").click();
      await page
        .getByTestId(`forget-worktree-button-${worktreeId}`)
        .waitFor({ state: "visible", timeout: 60_000 });
      await page.getByTestId(`forget-worktree-button-${worktreeId}`).click();
      await page
        .getByTestId("forget-worktree-dialog")
        .waitFor({ state: "visible", timeout: 30_000 });
      await page
        .getByTestId("forget-worktree-confirmation-input")
        .fill(worktreeId);
      await page.getByTestId("confirm-forget-worktree-button").click();
      await row.waitFor({ state: "detached", timeout: 60_000 });
      worktreeDeleted = true;
      evidence.steps.push({
        label: "preview-cas-archive-restore-and-typed-forget-completed",
      });

      evidence.stage = "cleanup-project";
      await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
      await page
        .getByTestId("desktop-sidebar")
        .waitFor({ state: "visible", timeout: 30_000 });
      await removeProject(page, projectName, projectId);
      projectId = "";
      assertDiagnostics(evidence);
      evidence.stage = "passed";
    } catch (error) {
      failure = error;
      evidence.failure =
        error instanceof Error ? error.stack || error.message : String(error);
      evidence.body = (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 12_000);
      await shot(page, context, `failure-${evidence.stage}.png`).catch(
        () => undefined,
      );
    } finally {
      if (taskId && !taskDeleted) {
        try {
          await rawRuntimeRequest(page, "runtime.tasks.archive", {
            deviceId: "local",
            taskId,
            ...(worktreePath ? { workspacePath: worktreePath } : {}),
          });
          evidence.cleanup.push({ kind: "task-archive", taskId });
        } catch (error) {
          evidence.cleanup.push({
            kind: "task-archive",
            taskId,
            error: String(error),
          });
        }
      }
      if (worktreePath && !worktreeDeleted) {
        try {
          await execFile("git", [
            "-C",
            worktreePath,
            "clean",
            "-f",
            "--",
            createdFile,
          ]).catch(() => undefined);
          const preview = await rawRuntimeRequest(
            page,
            "runtime.worktrees.archive.preview",
            { deviceId: "local", path: worktreePath },
          );
          if (preview?.preview?.archiveAllowed) {
            await rawRuntimeRequest(page, "runtime.worktrees.archive", {
              deviceId: "local",
              path: worktreePath,
              expectedRevision: preview.preview.revision,
              expectedContentToken: preview.preview.contentToken,
              riskAccepted: preview.preview.requiresConfirmation === true,
            });
          }
          evidence.cleanup.push({ kind: "worktree", path: worktreePath });
        } catch (error) {
          evidence.cleanup.push({
            kind: "worktree",
            path: worktreePath,
            error: String(error),
          });
        }
      }
      if (projectId) {
        try {
          await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
          await removeProject(page, projectName, projectId);
          evidence.cleanup.push({ kind: "project", id: projectId });
        } catch (error) {
          evidence.cleanup.push({
            kind: "project",
            id: projectId,
            error: String(error),
          });
        }
      }
      evidence.providerModels = modelFixture.requests.map(
        (request) => request?.model ?? null,
      );
      await context.writeArtifactJson(
        "workspace-managed-worktree-conversation.json",
        evidence,
      );
    }
    if (failure) throw failure;
    return evidence;
  },
);

async function initRepository(workspace, branch, marker) {
  await execFile("git", ["-C", workspace, "init", "-b", "main"]);
  await execFile("git", [
    "-C",
    workspace,
    "config",
    "user.name",
    "KCoder Studio E2E",
  ]);
  await execFile("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "kcoder-studio-e2e@example.invalid",
  ]);
  await execFile("git", ["-C", workspace, "add", "."]);
  await execFile("git", ["-C", workspace, "commit", "-m", "baseline"]);
  await execFile("git", ["-C", workspace, "checkout", "-b", branch]);
  await execFile(
    "sh",
    ["-c", "printf '%s\\n' \"$1\" > BRANCH_BASE.txt", "sh", marker],
    { cwd: workspace },
  );
  await execFile("git", ["-C", workspace, "add", "BRANCH_BASE.txt"]);
  await execFile("git", ["-C", workspace, "commit", "-m", "feature baseline"]);
  await execFile("git", ["-C", workspace, "checkout", "main"]);
}

async function gitWorktreeList(workspace) {
  const { stdout } = await execFile("git", [
    "-C",
    workspace,
    "worktree",
    "list",
    "--porcelain",
  ]);
  return {
    raw: stdout,
    paths: stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice(9))),
  };
}

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response?.status(), 200);
  const input = page.locator('input[name="token"]');
  if (await input.count()) {
    await input.fill(gateway.authToken);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/login"), {
        timeout: 30_000,
      }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page
    .getByTestId("desktop-sidebar")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function createProject(page, workspace, name) {
  await page.getByTestId("projects-create-button").click();
  await page.getByTestId("project-create-local-option").click();
  const picker = page.getByTestId("standalone-folder-project-dialog");
  const pathInput = picker.getByTestId("device-folder-path-input");
  await pathInput.fill(workspace);
  await pathInput.press("Enter");
  await page.waitForTimeout(300);
  assert.equal(
    await pathInput.inputValue(),
    workspace,
    "目录选择器没有稳定到目标绝对路径",
  );
  await picker.getByTestId("confirm-device-folder-picker-button").click();
  const dialog = page.getByTestId("local-project-create-dialog");
  await dialog.getByTestId("local-project-create-name-input").fill(name);
  await dialog.getByTestId("confirm-local-project-create-button").click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  const testId = await project
    .locator('[data-testid^="project-row-"]')
    .first()
    .getAttribute("data-testid");
  const id = testId?.replace("project-row-", "") || "";
  assert.match(id, /^\d+$/);
  return id;
}

async function selectProject(page, id, name) {
  await page.getByTestId("project-work-button").first().click();
  await page.getByTestId(`project-option-${id}`).click();
  await page
    .getByTestId("project-work-button")
    .filter({ hasText: name })
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function sendPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.keyboard.insertText(prompt);
  await page.waitForFunction(
    () => {
      const button = document.querySelector(
        '[data-testid="send-message-button"]',
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.getByTestId("send-message-button").click();
}

async function waitConversation(page, prompt) {
  await assertConversation(page, prompt);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '[data-testid="thinking-indicator"],[data-testid="pause-response-button"]',
      ).length === 0,
    undefined,
    { timeout: 30_000 },
  );
  const taskId = new URL(page.url()).searchParams.get("taskId") || "";
  assert.ok(taskId.startsWith("kcoder:local:"), `unexpected task id ${taskId}`);
  return taskId;
}

async function assertConversation(page, prompt) {
  await page
    .getByTestId("message-user")
    .filter({ hasText: prompt })
    .last()
    .waitFor({ state: "visible", timeout: 30_000 });
  const reply = `deterministic renderer response: ${prompt}`;
  await page
    .getByTestId("message-assistant")
    .filter({ hasText: reply })
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: reply })
      .count(),
    1,
  );
}

async function readEnvironmentWorkspacePath(page) {
  const popover = page.getByTestId("environment-info-popover");
  if (!(await popover.isVisible().catch(() => false)))
    await page.getByTestId("environment-info-button").click();
  await popover.waitFor({ state: "visible", timeout: 30_000 });
  const button = popover.getByTestId("environment-workspace-path-button");
  const path = await button.getAttribute("title");
  assert.ok(path, "环境弹层未提供完整 workspace path");
  await page.getByTestId("environment-info-button").click();
  return path;
}

async function openRightFiles(page) {
  const shell = page.getByTestId("right-workspace-panel-shell");
  if ((await shell.getAttribute("aria-hidden").catch(() => "true")) === "true")
    await page.getByTestId("toggle-right-workspace-panel-button").click();
  if (
    await page
      .getByTestId("workspace-file-tree")
      .isVisible()
      .catch(() => false)
  )
    return;
  if (await page.getByTestId("right-workspace-file-tab").count()) {
    await page.getByTestId("right-workspace-file-tab").click();
    return;
  }
  if (
    await page
      .getByTestId("right-workspace-launcher")
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByTestId("right-workspace-file-option").click();
  } else {
    await page.getByTestId("right-workspace-new-tab-button").click();
    await page
      .getByTestId("right-workspace-new-tab-menu")
      .getByTestId("right-workspace-file-option")
      .click();
  }
  await page
    .getByTestId("workspace-file-tree")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function addRightTerminal(page) {
  await page.getByTestId("right-workspace-new-tab-button").click();
  await page
    .getByTestId("right-workspace-new-tab-menu")
    .getByTestId("right-workspace-terminal-option")
    .click();
  await activeTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
}

async function addOrSelectRightTerminal(page) {
  if (await page.getByTestId("right-workspace-terminal-tab").count()) {
    await page.getByTestId("right-workspace-terminal-tab").click();
    await activeTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
    return;
  }
  await addRightTerminal(page);
}

function activeTerminal(page) {
  return page
    .locator(
      '[data-testid="remote-terminal"]:visible, [data-testid="embedded-local-terminal"]:visible',
    )
    .first();
}

async function terminalCreateProbe(page, workspace, fileName, stamp) {
  const terminal = activeTerminal(page);
  const input = terminal.locator("textarea.xterm-helper-textarea").first();
  await input.click();
  const quotedFile = shellQuote(fileName);
  await page.keyboard.insertText(
    `printf 'WORKTREE_${stamp}\\n' > ${quotedFile}; printf '__WT_CREATE_OK_${stamp}__\\n'`,
  );
  await page.keyboard.press("Enter");
  await waitTerminalLine(terminal, `__WT_CREATE_OK_${stamp}__`);
  return {
    label: "terminal-created-worktree-only-file",
    workspace: resolve(workspace),
    fileName,
  };
}

async function terminalCwdProbe(page, workspace, marker) {
  const terminal = activeTerminal(page);
  const input = terminal.locator("textarea.xterm-helper-textarea").first();
  await input.click();
  await page.keyboard.insertText(
    `if [ -r WORKTREE_ONLY.txt ]; then printf '__WT_CWD_OK_${marker}__\\n'; else printf '__WT_CWD_BAD_${marker}__\\n'; fi`,
  );
  await page.keyboard.press("Enter");
  const output = await waitTerminalLine(terminal, `__WT_CWD_OK_${marker}__`);
  assert.equal(output.lines.includes(`__WT_CWD_BAD_${marker}__`), false);
  return {
    label: "terminal-cwd-after-refresh",
    workspace: resolve(workspace),
    marker,
  };
}

async function exitActiveTerminal(page) {
  const terminal = activeTerminal(page);
  const input = terminal.locator("textarea.xterm-helper-textarea").first();
  await input.click();
  await page.keyboard.insertText("exit");
  await page.keyboard.press("Enter");
  await terminal.waitFor({ state: "detached", timeout: 30_000 });
}

async function waitTerminalLine(terminal, line) {
  const deadline = Date.now() + 30_000;
  let text = "";
  while (Date.now() < deadline) {
    text = await terminal
      .locator(".xterm-rows")
      .innerText()
      .catch(() => "");
    const lines = text.split("\n").map((value) => value.trim());
    if (lines.includes(line)) return { text, lines };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`terminal line timeout: ${line}\n${text}`);
}

async function waitFileTarget(page, expected) {
  const normalized = resolve(expected);
  await page.waitForFunction(
    (target) => {
      const value = document
        .querySelector('[data-testid="workspace-file-path"]')
        ?.textContent?.trim();
      return value === target;
    },
    normalized,
    { timeout: 30_000 },
  );
  assert.equal(
    resolve((await page.getByTestId("workspace-file-path").innerText()).trim()),
    normalized,
  );
}

async function expandTreeRoot(page, expectedRoot) {
  const tree = page.getByTestId("workspace-file-tree-pierre");
  await tree.waitFor({ state: "visible", timeout: 30_000 });
  const target = resolve(expectedRoot);
  const root = await tree.evaluate((host, expected) => {
    const buttons = [
      ...(host.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? []),
    ];
    const button =
      buttons.find(
        (item) => item.getAttribute("data-item-path") === expected,
      ) ?? buttons[0];
    if (!(button instanceof HTMLElement)) return null;
    return {
      expanded: button.getAttribute("aria-expanded"),
      path: button.getAttribute("data-item-path"),
    };
  }, target);
  assert.ok(root, "文件树根节点不可见");
  if (root.expanded === "true") return;
  const point = await tree.evaluate((host, expected) => {
    const buttons = [
      ...(host.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? []),
    ];
    const button =
      buttons.find(
        (item) => item.getAttribute("data-item-path") === expected,
      ) ?? buttons[0];
    if (!(button instanceof HTMLElement)) return null;
    const rect = button.getBoundingClientRect();
    return {
      x: rect.x + Math.min(18, rect.width / 2),
      y: rect.y + rect.height / 2,
    };
  }, target);
  assert.ok(point, "文件树根节点无法点击");
  await page.mouse.click(point.x, point.y);
}

async function waitForTreeItem(page, label) {
  await page.waitForFunction(
    (expected) => {
      const tree = document.querySelector(
        '[data-testid="workspace-file-tree-pierre"]',
      );
      return [
        ...(tree?.shadowRoot?.querySelectorAll('button[data-type="item"]') ??
          []),
      ].some((button) => {
        const path = button.getAttribute("data-item-path") || "";
        return (
          button.getAttribute("aria-label") === expected ||
          path.endsWith(`/${expected}`) ||
          button.textContent?.includes(expected)
        );
      });
    },
    label,
    { timeout: 30_000 },
  );
}

async function openRuntimeTask(page, projectName, taskId) {
  const project = byProject(page, projectName);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  const button = project.getByTestId("project-item-button");
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
  const row = page.locator(
    `[data-testid="runtime-local-task-row-${escapeCss(taskId)}"]:visible`,
  );
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.evaluate((node) => node.click());
  await page.waitForURL((url) => url.searchParams.get("taskId") === taskId, {
    timeout: 30_000,
  });
  await page
    .getByTestId("environment-info-button")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function archiveTask(page, projectName, taskId) {
  const project = byProject(page, projectName);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  const button = project.getByTestId("project-item-button");
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
  const row = page.locator(
    `[data-testid="runtime-local-task-row-${escapeCss(taskId)}"]:visible`,
  );
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.hover();
  await page.getByTestId(`runtime-local-task-archive-${taskId}`).click();
  await row.waitFor({ state: "detached", timeout: 30_000 });
}

async function removeProject(page, name, id) {
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  await project.hover();
  await page.getByTestId(`project-menu-${id}`).click();
  await page.getByTestId(`remove-project-${id}`).click();
  await page.getByTestId(`remove-project-dialog-${id}-confirm-button`).click();
  await page
    .locator(`[data-testid="project-row-${id}"]:visible`)
    .waitFor({ state: "detached", timeout: 30_000 });
}

async function rawRuntimeRequest(page, method, params) {
  return page.evaluate(
    async ({ method, params }) =>
      window.__TAURI_INTERNALS__?.invoke("local_executor_request", {
        method,
        params,
      }),
    { method, params },
  );
}

async function installIpcCapture(page) {
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (
      !internals ||
      typeof internals.invoke !== "function" ||
      window.__managedWorktreeIpcCaptureInstalled
    )
      return;
    const original = internals.invoke.bind(internals);
    window.__managedWorktreeIpcCalls = [];
    window.__managedWorktreeIpcCaptureInstalled = true;
    internals.invoke = async (command, args) => {
      const method = command === "local_executor_request" ? args?.method : null;
      const interesting = [
        "runtime.tasks.create",
        "runtime.tasks.list",
        "runtime.tasks.archive",
        "runtime.archived_conversations.list",
      ].includes(method);
      const params = args?.params ?? {};
      const request = interesting
        ? {
            method,
            workspacePath: params.workspacePath ?? null,
            execution: params.execution ?? null,
            executionWorkspacePath:
              params.executionRequest?.project_workspace_path ?? null,
            executionWorkspaceSource:
              params.executionRequest?.workspace_source ?? null,
            taskId: params.taskId ?? params.executionRequest?.task_id ?? null,
          }
        : null;
      try {
        const result = await original(command, args);
        if (request) {
          const workspaces = Array.isArray(result?.workspaces)
            ? result.workspaces.map((workspace) => ({
                workspacePath:
                  workspace?.workspacePath ??
                  workspace?.workspace_path ??
                  workspace?.path ??
                  null,
                tasks: Array.isArray(workspace?.tasks)
                  ? workspace.tasks.map((task) => ({
                      taskId: task?.taskId ?? task?.task_id ?? null,
                      workspacePath:
                        task?.workspacePath ?? task?.workspace_path ?? null,
                    }))
                  : [],
              }))
            : [];
          window.__managedWorktreeIpcCalls.push({
            ...request,
            response: {
              accepted: result?.accepted ?? null,
              taskId: result?.taskId ?? result?.task_id ?? null,
              workspacePath:
                result?.workspacePath ?? result?.workspace_path ?? null,
              workspaces,
            },
          });
        }
        return result;
      } catch (error) {
        if (request)
          window.__managedWorktreeIpcCalls.push({
            ...request,
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    };
  });
}

async function readIpcCapture(page) {
  return page.evaluate(() => window.__managedWorktreeIpcCalls ?? []);
}

async function waitForArchivedTask(page, taskId) {
  const deadline = Date.now() + 30_000;
  let response = { items: [], total: 0 };
  while (Date.now() < deadline) {
    response = await rawRuntimeRequest(
      page,
      "runtime.archived_conversations.list",
      {},
    );
    if ((response?.items ?? []).some((item) => item.taskId === taskId))
      return response;
    await page.waitForTimeout(150);
  }
  throw new Error(
    `归档未持久化到 archived list：${taskId}; response=${JSON.stringify(response)}`,
  );
}

function observe(page, evidence) {
  page.on("pageerror", (error) =>
    evidence.diagnostics.console.push({
      type: "pageerror",
      stage: evidence.stage,
      text: error.message,
    }),
  );
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      evidence.diagnostics.console.push({
        type: message.type(),
        stage: evidence.stage,
        text: message.text(),
      });
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      evidence.diagnostics.failedResponses.push({
        stage: evidence.stage,
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
  });
  page.on("requestfailed", (request) =>
    evidence.diagnostics.requestFailures.push({
      stage: evidence.stage,
      error: request.failure()?.errorText,
      path: new URL(request.url()).pathname,
    }),
  );
  page.on("websocket", (socket) => {
    const pending = new Map();
    socket.on("socketerror", (error) =>
      evidence.diagnostics.socketErrors.push({
        stage: evidence.stage,
        text: String(error),
      }),
    );
    socket.on("framesent", (event) =>
      captureRpcFrame(evidence, "sent", event.payload, pending),
    );
    socket.on("framereceived", (event) =>
      captureRpcFrame(evidence, "received", event.payload, pending),
    );
  });
}

function captureRpcFrame(evidence, direction, payload, pending) {
  if (typeof payload !== "string") return;
  try {
    const frame = JSON.parse(payload);
    const method = typeof frame.method === "string" ? frame.method : null;
    const requestInteresting =
      method?.startsWith("runtime.worktrees.") ||
      method === "runtime.tasks.create" ||
      method?.startsWith("terminal/");
    if (direction === "sent" && requestInteresting && frame.id != null)
      pending.set(frame.id, method);
    const responseMethod =
      direction === "received" && frame.id != null
        ? pending.get(frame.id)
        : null;
    const interesting = requestInteresting || Boolean(responseMethod);
    if (!interesting) return;
    const params =
      frame.params && typeof frame.params === "object" ? frame.params : {};
    evidence.rpcFrames.push({
      direction,
      stage: evidence.stage,
      id: frame.id ?? null,
      method: method ?? responseMethod,
      execution: params.execution ?? null,
      workspacePath:
        params.workspacePath ??
        params.executionRequest?.project_workspace_path ??
        null,
      workspaceSource: params.executionRequest?.workspace_source ?? null,
      sourcePath: params.sourcePath ?? null,
      worktreeId: params.worktreeId ?? null,
      ref: params.ref ?? null,
      resultPath: frame.result?.path ?? frame.result?.worktree?.path ?? null,
      resultState: frame.result?.worktree?.state ?? null,
      sessionId:
        params.session_id ??
        frame.result?.session_id ??
        frame.result?.session?.id ??
        null,
      error: frame.error?.message ?? null,
    });
    if (direction === "received" && frame.id != null) pending.delete(frame.id);
  } catch {
    // Binary or non-JSON frames are irrelevant to this test's RPC-routing evidence.
  }
}

function assertDiagnostics(evidence) {
  assert.deepEqual(evidence.diagnostics.console, []);
  assert.deepEqual(evidence.diagnostics.failedResponses, []);
  assert.deepEqual(evidence.diagnostics.requestFailures, []);
  assert.deepEqual(evidence.diagnostics.socketErrors, []);
}

async function assertPathExists(path) {
  await access(path);
}
async function assertPathMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}
function byProject(page, name) {
  return page.getByTestId("project-item").filter({ hasText: name }).first();
}
function sanitizeTestId(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
function escapeCss(value) {
  return value.replace(/["\\]/g, "\\$&");
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function shot(page, context, name) {
  const path = context.pathInCase(
    "system-chromium",
    "workspace-managed-worktree",
    name,
  );
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
