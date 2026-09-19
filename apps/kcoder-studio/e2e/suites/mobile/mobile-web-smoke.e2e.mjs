import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-auth-conversation",
    tier: "pr-smoke",
    modelPolicy: "model-independent JavaScript mock gateway",
    retainSuccessLogs: true,
  },
  async (context) => {
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-web-gateway",
      workspace: appRoot,
      env: {
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_WEB_ROOT: mobileDist,
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-web-chromium",
    });
    const page = await chromium.newPage({
      viewport: { width: 390, height: 844 },
    });
    const browserErrors = [];
    page.on("pageerror", (error) =>
      browserErrors.push(`pageerror: ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        browserErrors.push(`console: ${message.text()}`);
    });
    const selectWorkspaceTab = async (tabId) => {
      await page.getByTestId("workspace-tab-switcher").click();
      const target = page.getByTestId(`workspace-tab-${tabId}`);
      await target.waitFor({ state: "visible", timeout: 10_000 });
      await target.click();
      await target.waitFor({ state: "hidden", timeout: 10_000 });
    };

    const loginResponse = await page.goto(gateway.baseUrl, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(loginResponse?.status(), 200);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.waitForSelector('[data-testid="welcome-direct-connection"]', {
        timeout: 30_000,
      }),
      page.locator('button[type="submit"]').click(),
    ]);

    await page.getByTestId("welcome-direct-connection").click();
    await page
      .getByRole("dialog", { name: "直接连接", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await page.getByRole("dialog", { name: "直接连接", exact: true }).count(),
      1,
      "直接连接只能暴露一个具名 dialog 语义",
    );
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("data-testid") ===
        "gateway-endpoint",
    );
    assert.equal(
      await page.getByTestId("gateway-endpoint").inputValue(),
      gateway.baseUrl,
      "Web 端直接连接应默认使用当前页面的 Gateway 地址",
    );
    await page.getByTestId("gateway-token").fill(gateway.authToken);
    await page.getByTestId("gateway-connect").click();
    try {
      await page
        .getByTestId("new-workspace")
        .waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      await capture(page, context, "connection-failure.png");
      await context.writeArtifactJson("connection-failure.json", {
        url: page.url(),
        body: (await page.locator("body").innerText()).slice(0, 8_000),
        storage: await page.evaluate(() =>
          Object.fromEntries(
            Array.from({ length: localStorage.length }, (_, index) =>
              localStorage.key(index),
            )
              .filter((key) => key !== null)
              .map((key) => [key, localStorage.getItem(key)]),
          ),
        ),
      });
      throw error;
    }
    await capture(page, context, "home.png");
    assert.deepEqual(
      browserErrors,
      [],
      "登录和正常首页导航不能产生 hydration 或 console 错误",
    );

    const homeUrl = page.url();
    const profileId = decodeURIComponent(
      new URL(homeUrl).pathname.split("/").filter(Boolean)[1] ?? "",
    );
    assert.ok(profileId, `移动首页 URL 缺少 profileId：${homeUrl}`);
    await page.goto(
      `${gateway.baseUrl}/open-project?profileId=${encodeURIComponent(profileId)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByTestId("open-project-route")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(300);
    assert.deepEqual(
      browserErrors,
      [],
      "直接打开带 profileId 的静态深链不能产生 hydration 或 console 错误",
    );
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    try {
      await page
        .getByTestId("new-workspace")
        .waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      await capture(page, context, "dynamic-profile-failure.png");
      await context.writeArtifactJson("dynamic-profile-failure.json", {
        homeUrl,
        currentUrl: page.url(),
        body: (await page.locator("body").innerText()).slice(0, 8_000),
        browserErrors,
      });
      throw error;
    }

    await page.getByLabel("设置", { exact: true }).click();
    await page.getByTestId("terminal-settings").click();
    await page
      .getByRole("dialog", { name: "终端设置", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("radio", { name: "50,000", exact: true }).click();
    await page.getByLabel("关闭", { exact: true }).click();
    assert.match(
      await page.getByTestId("terminal-settings").innerText(),
      /50,000 行回滚/,
      "终端回滚设置应立即反映到设置页",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByTestId("terminal-settings")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.match(
      await page.getByTestId("terminal-settings").innerText(),
      /50,000 行回滚/,
      "终端回滚设置应持久化到重新加载后的 Web 客户端",
    );
    await capture(page, context, "settings.png");
    await page.getByTestId("diagnostics-settings").click();
    const diagnosticDialog = page.getByRole("dialog", {
      name: "连接诊断",
      exact: true,
    });
    await diagnosticDialog.waitFor({ state: "visible", timeout: 10_000 });
    await diagnosticDialog
      .getByText(gateway.baseUrl, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByLabel("重新运行诊断", { exact: true }).click();
    await page.setViewportSize({ width: 320, height: 568 });
    const diagnosticFootnote =
      diagnosticDialog.getByText(/诊断直接使用当前移动会话/);
    await diagnosticFootnote.scrollIntoViewIfNeeded();
    await diagnosticFootnote.waitFor({ state: "visible", timeout: 10_000 });
    await capture(page, context, "diagnostics-320.png");
    await page.getByLabel("关闭", { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("settings-host-local").click();
    await page
      .getByTestId("host-details-route")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page
      .getByText("浏览器", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page
      .getByText("查看此 Host 的任务历史", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await capture(page, context, "host-details.png");
    await page
      .getByTestId("host-details-route")
      .getByLabel("返回", { exact: true })
      .click();
    await page
      .getByTestId("terminal-settings")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByText("添加连接", { exact: true }).click();
    await page
      .getByTestId("server-id")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("server-id").fill("mobile-dirty-check");
    let dismissDialogType = null;
    const dismissDirty = new Promise((resolveDialog) =>
      page.once("dialog", async (dialog) => {
        dismissDialogType = dialog.type();
        await dialog.dismiss();
        resolveDialog();
      }),
    );
    await Promise.all([
      dismissDirty,
      page
        .getByTestId("server-editor-route")
        .getByLabel("返回", { exact: true })
        .click(),
    ]);
    assert.equal(
      dismissDialogType,
      "confirm",
      "Web 表单离开保护必须允许用户取消，而不是不可交互的 alert",
    );
    assert.match(page.url(), /\/server-editor$/, "取消放弃后应留在 SSH 编辑页");
    const acceptDirty = new Promise((resolveDialog) =>
      page.once("dialog", async (dialog) => {
        await dialog.accept();
        resolveDialog();
      }),
    );
    await Promise.all([
      acceptDirty,
      page
        .getByTestId("server-editor-route")
        .getByLabel("返回", { exact: true })
        .click(),
    ]);
    await page.waitForURL((url) => !url.pathname.endsWith("/server-editor"), {
      timeout: 10_000,
    });
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page
      .getByTestId("new-workspace")
      .waitFor({ state: "visible", timeout: 30_000 });

    await page.goto(
      `${gateway.baseUrl}/sessions?profileId=${encodeURIComponent(profileId)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByTestId("session-mock-active-session")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("session-actions-mock-active-session").click();
    await page
      .getByRole("dialog", { name: "任务操作", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("thread-rename-input").fill("已重命名移动任务");
    await capture(page, context, "session-actions.png");
    await page.getByTestId("thread-rename-save").click();
    await page
      .getByText("已重命名移动任务", { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByLabel("关闭", { exact: true }).click();
    await page
      .getByTestId("session-mock-active-session")
      .filter({ hasText: "已重命名移动任务" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("session-actions-mock-active-session").click();
    await page.getByTestId("thread-archive-action").click();
    await page
      .getByTestId("session-mock-active-session")
      .waitFor({ state: "hidden", timeout: 10_000 });
    await page.getByTestId("sessions-archived").click();
    await page
      .getByTestId("session-mock-archived-session")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("session-actions-mock-archived-session").click();
    await page.getByTestId("thread-archive-action").click();
    await page
      .getByTestId("session-mock-archived-session")
      .waitFor({ state: "hidden", timeout: 10_000 });
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page
      .getByTestId("new-workspace")
      .waitFor({ state: "visible", timeout: 30_000 });

    await page.getByTestId("new-workspace").click();
    const selectedServer = page.getByTestId("server-option-local");
    await selectedServer.click();
    assert.equal(
      await page.getByTestId("model-selector").isDisabled(),
      false,
      "再次点击当前服务器不能让模型选择永久停留在 loading 状态",
    );
    const defaultReasoning = page.getByRole("radio", { checked: true }).first();
    await defaultReasoning.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await defaultReasoning.getAttribute("aria-checked"),
      "true",
      "新建任务的推理强度应暴露 Web radio 选中状态",
    );
    await page
      .getByTestId("workspace-path")
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.ok(
      (await page.getByTestId("workspace-path").inputValue()).startsWith("/"),
      "新建工作区应恢复已登记项目或服务器默认目录",
    );
    await page.getByTestId("workspace-isolation-worktree").click();
    await page
      .getByTestId("workspace-git-ref")
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      await page.getByTestId("create-workspace").innerText(),
      /worktree/,
      "选择隔离模式后主操作应明确说明会创建 worktree",
    );
    await page.getByTestId("workspace-isolation-local").click();
    await page
      .getByTestId("workspace-git-ref")
      .waitFor({ state: "hidden", timeout: 10_000 });
    await page.getByTestId("new-workspace-prompt").fill("只回复 MOBILE_WEB_OK");
    await page.getByTestId("create-workspace").click();
    try {
      await page
        .getByTestId("message-user")
        .filter({ hasText: "MOBILE_WEB_OK" })
        .waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      await capture(page, context, "conversation-failure.png");
      await context.writeArtifactJson("conversation-failure.json", {
        url: page.url(),
        body: (await page.locator("body").innerText()).slice(0, 8_000),
      });
      throw error;
    }
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: "已连接当前虚拟机" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByTestId("send-message")
      .waitFor({ state: "visible", timeout: 10_000 });

    await page.getByTestId("message-input").fill("MOBILE_QUEUE_FIRST");
    await page.getByTestId("send-message").click();
    await page
      .getByTestId("stop-turn")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-input").fill("MOBILE_QUEUE_SECOND");
    await page.getByTestId("queue-message").click();
    await page
      .getByTestId("queued-message-0")
      .filter({ hasText: "MOBILE_QUEUE_SECOND" })
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await page.getByTestId("stop-turn").isVisible(),
      true,
      "运行中排队消息后应继续保留独立的停止按钮",
    );
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByTestId("message-input-root")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByTestId("message-user")
      .filter({ hasText: "MOBILE_QUEUE_SECOND" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page
      .getByTestId("queued-messages")
      .waitFor({ state: "hidden", timeout: 10_000 });
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: "MOBILE_QUEUE_SECOND" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page
      .getByTestId("send-message")
      .waitFor({ state: "visible", timeout: 10_000 });

    await page.getByTestId("conversation-model-selector").click();
    await page
      .getByRole("dialog", { name: "切换模型", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("conversation-model-mock-kimi").click();
    const highEffort = page
      .getByRole("dialog", { name: "切换模型", exact: true })
      .getByRole("radio", { name: "高", exact: true });
    await highEffort.click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="radio"]')].some(node => node.textContent?.trim() === '高' && node.getAttribute('aria-checked') === 'true'));
    assert.equal(
      await highEffort.getAttribute("aria-checked"),
      "true",
      "任务内推理强度应向 Web 屏幕阅读器暴露选中状态",
    );
    await page
      .getByRole("dialog", { name: "切换模型", exact: true })
      .getByLabel("关闭", { exact: true })
      .click();
    await page
      .getByTestId("conversation-model-selector")
      .filter({ hasText: /Kimi.*高/i })
      .waitFor({ state: "visible", timeout: 10_000 });

    await page
      .getByRole("link", { name: "打开 README 第一行", exact: true })
      .last()
      .click();
    await page
      .getByTestId("file-editor")
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      await page.getByTestId("file-editor").inputValue(),
      /# KCoder Studio/,
      "助手回复中的工作区文件链接应直接打开 Files 编辑器",
    );
    await page.getByLabel("返回文件树", { exact: true }).click();
    await page
      .getByTestId("file-tree-list")
      .waitFor({ state: "visible", timeout: 10_000 });
    await selectWorkspaceTab("agent");
    await page
      .getByRole("link", { name: "README.md:2", exact: true })
      .last()
      .click();
    await page
      .getByTestId("file-editor")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="file-editor"]');
      return editor === document.activeElement && editor?.selectionStart === 16;
    });
    await page.getByLabel("返回文件树", { exact: true }).click();
    await selectWorkspaceTab("agent");

    await page.getByTestId("message-input").fill("MOBILE_APPROVAL");
    await page.getByTestId("send-message").click();
    await page
      .getByTestId("approval-card")
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      await page.getByTestId("approval-card").innerText(),
      /echo MOBILE_APPROVAL/,
      "审批卡必须展示将要执行的具体命令",
    );
    await page.getByTestId("approval-accept").click();
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: "MOBILE_APPROVAL_ACCEPTED: accept" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page
      .getByTestId("send-message")
      .waitFor({ state: "visible", timeout: 10_000 });

    await page.getByTestId("message-input").fill("MOBILE_QUESTION");
    await page.getByTestId("send-message").click();
    await page
      .getByTestId("question-card")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("question-option-deployment-automatic").click();
    assert.equal(
      await page.getByTestId("question-submit").isDisabled(),
      false,
      "选择必答项后提交按钮应立即可用",
    );
    await page.getByTestId("question-submit").click();
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: "MOBILE_QUESTION_ANSWERED" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page
      .getByTestId("send-message")
      .waitFor({ state: "visible", timeout: 10_000 });
    const messageList = page.getByTestId("message-list");
    const messageListBox = await messageList.boundingBox();
    assert.ok(messageListBox, "消息列表必须有可交互的布局区域");
    await page.waitForTimeout(180);
    await page.mouse.move(
      messageListBox.x + messageListBox.width / 2,
      messageListBox.y + 48,
    );
    await page.mouse.wheel(0, -10_000);
    await page
      .getByTestId("jump-to-latest")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("jump-to-latest").click();
    // Change layout before smooth scrolling completes to verify that intermediate
    // scroll events do not cancel the programmatic follow lock. Returning to latest completes only after actually reaching the bottom.
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForFunction(
      () => {
        const list = document.querySelector('[data-testid="message-list"]');
        return (
          list && list.scrollHeight - list.clientHeight - list.scrollTop < 96
        );
      },
      undefined,
      { timeout: 10_000 },
    );
    assert.equal(
      await page.getByTestId("jump-to-latest").isHidden(),
      true,
      "跟随最新消息时缩窄窗口或弹出键盘后必须继续锚定底部",
    );
    await page.setViewportSize({ width: 390, height: 844 });

    // Model-independent workspace lifecycle gate: a visited tool panel remains mounted,
    // and switching back cannot destroy PTYs, browser sessions, or unsaved file edits.
    for (const [panel, tabId] of [
      ["terminal", "terminal-1"],
      ["browser", "browser-1"],
      ["files", "files-1"],
    ]) {
      await selectWorkspaceTab(tabId);
      await page
        .getByTestId(`${panel}-panel`)
        .waitFor({ state: "visible", timeout: 10_000 });
      await selectWorkspaceTab("agent");
      assert.equal(
        await page.getByTestId(`${panel}-panel`).count(),
        1,
        `${panel} 面板切走后应继续保留`,
      );
      assert.equal(
        await page.getByTestId(`${panel}-panel`).isHidden(),
        true,
        `${panel} 面板切走后应隐藏`,
      );
    }

    await selectWorkspaceTab("changes");
    await page
      .getByTestId("git-stage-all")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("git-stage-all").click();
    await page
      .getByTestId("git-open-commit")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("git-open-commit").click();
    await page
      .getByTestId("git-commit-message")
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await page.getByTestId("git-commit-message").inputValue(),
      "Update mobile workflow",
      "提交面板应读取 app-server 生成的提交说明",
    );
    await page
      .getByTestId("git-commit-message")
      .fill("Test mobile Git workflow");
    await page.getByTestId("git-commit").click();
    try {
      await page
        .getByTestId("git-commit-message")
        .waitFor({ state: "hidden", timeout: 10_000 });
      await page
        .getByText("codex/mobile-workflow", { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(
        await page.getByTestId("git-stage-all").count(),
        0,
        "提交成功后最近提交视图不应继续显示工作树操作",
      );
    } catch (error) {
      await capture(page, context, "changes-workflow-failure.png");
      await context.writeArtifactJson("changes-workflow-failure.json", {
        body: (await page.locator("body").innerText()).slice(0, 8_000),
        committedMode: await page
          .getByTestId("changes-mode-committed")
          .getAttribute("aria-selected"),
        commitDisabled: await page
          .getByTestId("git-commit")
          .isDisabled()
          .catch(() => null),
      });
      throw error;
    }
    await capture(page, context, "changes-workflow.png");
    const changesPanel = page.getByTestId("changes-panel");
    await changesPanel.getByText("README.md", { exact: true }).first().click();
    await page
      .getByTestId("changes-open-file")
      .waitFor({ state: "visible", timeout: 10_000 });
    const changesOpenFileBox = await page
      .getByTestId("changes-open-file")
      .boundingBox();
    assert.ok(
      changesOpenFileBox && changesOpenFileBox.height >= 44,
      `Changes 的文件打开操作应至少44px高：${JSON.stringify(changesOpenFileBox)}`,
    );
    await page.getByTestId("changes-open-file").click();
    await page
      .getByTestId("file-editor")
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      await page.getByTestId("file-editor").inputValue(),
      /# KCoder Studio/,
      "Changes 选中的文件应能直接在安全的 Files 标签中打开",
    );

    await selectWorkspaceTab("terminal-1");
    await page
      .getByTestId("terminal-emulator")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("terminal-emulator").click();
    await page.keyboard.type("echo MOBILE_TERMINAL_INPUT");
    await page.keyboard.press("Enter");
    try {
      await page
        .locator(".xterm-accessibility-tree")
        .filter({ hasText: "MOBILE_TERMINAL_OK" })
        .waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      await capture(page, context, "terminal-input-failure.png");
      await context.writeArtifactJson("terminal-input-failure.json", {
        body: (await page.locator("body").innerText()).slice(0, 8_000),
        activeElement: await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          className: document.activeElement?.getAttribute("class"),
          ariaLabel: document.activeElement?.getAttribute("aria-label"),
        })),
        terminalText: (
          await page.getByTestId("terminal-panel").innerText()
        ).slice(0, 4_000),
      });
      throw error;
    }

    await page.getByTestId("workspace-tab-switcher").click();
    let terminalCloseDialog = null;
    const dismissTerminalClose = new Promise((resolveDialog) =>
      page.once("dialog", async (dialog) => {
        terminalCloseDialog = dialog.type();
        await dialog.dismiss();
        resolveDialog();
      }),
    );
    await Promise.all([
      dismissTerminalClose,
      page.getByLabel("关闭终端 1", { exact: true }).click(),
    ]);
    assert.equal(
      terminalCloseDialog,
      "confirm",
      "关闭运行中的终端标签必须先确认",
    );
    assert.equal(
      await page.getByTestId("workspace-tab-terminal-1").count(),
      1,
      "取消关闭终端后必须保留同一 PTY 标签",
    );
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByLabel("关闭终端 1", { exact: true }).click();
    await page
      .getByTestId("workspace-tab-terminal-1")
      .waitFor({ state: "hidden", timeout: 10_000 });
    await page.getByTestId("workspace-tab-browser-1").click();
    await page
      .getByTestId("workspace-tab-browser-1")
      .waitFor({ state: "hidden", timeout: 10_000 });
    await page
      .getByTestId("browser-url-input")
      .fill("http://mobile-browser.test/");
    await page
      .getByTestId("browser-panel")
      .getByLabel("打开", { exact: true })
      .click();
    await page
      .locator(
        '[data-testid="browser-panel"] img[src^="data:image/svg+xml;base64,"]',
      )
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await page
        .getByTestId("browser-panel")
        .getByLabel("前进", { exact: true })
        .isDisabled(),
      true,
      "新建远程浏览会话时前进按钮应禁用",
    );
    await page
      .getByTestId("browser-url-input")
      .fill("http://mobile-browser-second.test/");
    await page
      .getByTestId("browser-panel")
      .getByLabel("打开", { exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="browser-url-input"]')?.value ===
        "http://mobile-browser-second.test/",
    );
    await page
      .getByTestId("browser-panel")
      .getByLabel("后退", { exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="browser-url-input"]')?.value ===
        "http://mobile-browser.test/",
    );
    assert.equal(
      await page
        .getByTestId("browser-panel")
        .getByLabel("前进", { exact: true })
        .isDisabled(),
      false,
      "后退后应允许前进到刚才的页面",
    );
    await page
      .getByTestId("browser-panel")
      .getByLabel("前进", { exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="browser-url-input"]')?.value ===
        "http://mobile-browser-second.test/",
    );
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(300);
    const narrowMetrics = await page.evaluate(() => {
      const enter = document
        .querySelector('[aria-label="回车"]')
        ?.getBoundingClientRect();
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        enter: enter
          ? {
              left: enter.left,
              right: enter.right,
              width: enter.width,
              height: enter.height,
            }
          : null,
      };
    });
    assert.equal(
      narrowMetrics.scrollWidth,
      narrowMetrics.clientWidth,
      `320px Browser 不应横向溢出：${JSON.stringify(narrowMetrics)}`,
    );
    assert.ok(
      narrowMetrics.enter &&
        narrowMetrics.enter.right <= 320 &&
        narrowMetrics.enter.width >= 44 &&
        narrowMetrics.enter.height >= 44,
      `回车按钮应完整可见且至少44px：${JSON.stringify(narrowMetrics.enter)}`,
    );
    await page.setViewportSize({ width: 320, height: 320 });
    await page
      .getByTestId("browser-short-controls")
      .waitFor({ state: "visible", timeout: 10_000 });
    const shortBrowserMetrics = await page.evaluate(() => {
      const frame = document
        .querySelector('[data-testid="browser-frame"]')
        ?.getBoundingClientRect();
      const controls = document
        .querySelector('[data-testid="browser-short-controls"]')
        ?.getBoundingClientRect();
      return {
        frameHeight: frame?.height ?? 0,
        controlsHeight: controls?.height ?? 0,
      };
    });
    assert.ok(
      shortBrowserMetrics.frameHeight >= 48 &&
        shortBrowserMetrics.controlsHeight <= 56,
      `软键盘压缩高度时仍应能边看页面边输入：${JSON.stringify(shortBrowserMetrics)}`,
    );
    await capture(page, context, "browser-short-height.png");
    await page.setViewportSize({ width: 320, height: 568 });

    await selectWorkspaceTab("files-1");
    const filesPanel = page.getByTestId("files-panel");
    await filesPanel.waitFor({ state: "visible", timeout: 10_000 });
    if (
      await page
        .getByTestId("file-editor")
        .isVisible()
        .catch(() => false)
    ) {
      await filesPanel.getByLabel("返回文件树", { exact: true }).click();
    }
    try {
      await filesPanel
        .getByRole("button", { name: "文件 README.md", exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      await capture(page, context, "files-panel-failure.png");
      await context.writeArtifactJson("files-panel-failure.json", {
        body: (await page.locator("body").innerText()).slice(0, 8_000),
        filesPanel: (await page.getByTestId("files-panel").innerText()).slice(
          0,
          4_000,
        ),
      });
      throw error;
    }
    await filesPanel
      .getByRole("button", { name: "文件 README.md", exact: true })
      .click();
    await page
      .getByTestId("file-editor")
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      await page.getByTestId("file-line-numbers").innerText(),
      /^1\s+2/m,
      "移动代码编辑器应提供与内容滚动同步的行号栏",
    );
    const longEditorContent = Array.from(
      { length: 90 },
      (_, index) => `line ${index + 1} ${"long-code-column-".repeat(8)}`,
    ).join("\n");
    await page.getByTestId("file-editor").fill(longEditorContent);
    await page.getByTestId("file-editor").evaluate((editor) => {
      editor.scrollTop = 420;
      editor.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForTimeout(120);
    const editorScrollMetrics = await page.evaluate(() => {
      const editor = document.querySelector('[data-testid="file-editor"]');
      const gutterText = document.querySelector(
        '[data-testid="file-line-numbers"]',
      )?.firstElementChild;
      const transform = gutterText
        ? getComputedStyle(gutterText).transform
        : "none";
      const translateY =
        transform && transform !== "none"
          ? new DOMMatrixReadOnly(transform).m42
          : 0;
      return {
        scrollTop: editor?.scrollTop ?? 0,
        scrollWidth: editor?.scrollWidth ?? 0,
        clientWidth: editor?.clientWidth ?? 0,
        whiteSpace: editor ? getComputedStyle(editor).whiteSpace : "",
        translateY,
      };
    });
    assert.ok(
      editorScrollMetrics.scrollTop >= 300 &&
        editorScrollMetrics.translateY <= -300,
      `Web textarea 与行号必须同步滚动：${JSON.stringify(editorScrollMetrics)}`,
    );
    assert.equal(
      editorScrollMetrics.whiteSpace,
      "pre",
      "代码编辑器必须关闭软换行以保持逻辑行号对齐",
    );
    assert.ok(
      editorScrollMetrics.scrollWidth > editorScrollMetrics.clientWidth,
      `320px 长代码行应使用内部横向滚动而不是软换行：${JSON.stringify(editorScrollMetrics)}`,
    );
    const fileSaveBox = await page
      .getByTestId("files-panel")
      .getByLabel("保存", { exact: true })
      .boundingBox();
    assert.ok(
      fileSaveBox && fileSaveBox.width >= 44 && fileSaveBox.height >= 44,
      `文件保存触控区应至少44px：${JSON.stringify(fileSaveBox)}`,
    );
    const recoveredDraft = "# 恢复测试\n\nMOBILE_FILE_DRAFT_OK\n";
    await page.getByTestId("file-editor").fill(recoveredDraft);
    await page.waitForTimeout(500);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByTestId("files-panel")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page.getByTestId("message-input-root").isHidden(),
      true,
      "任务刷新后应恢复最后使用的工作区标签，而不是回到智能体面板",
    );
    await page
      .getByTestId("file-editor")
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await page.getByTestId("file-editor").inputValue(),
      recoveredDraft,
      "文件页应自动打开并恢复未保存草稿，无需用户重新定位文件",
    );
    let fileDiscardDialog = null;
    const dismissFileDiscard = new Promise((resolveDialog) =>
      page.once("dialog", async (dialog) => {
        fileDiscardDialog = dialog.type();
        await dialog.dismiss();
        resolveDialog();
      }),
    );
    await Promise.all([
      dismissFileDiscard,
      page
        .getByTestId("files-panel")
        .getByLabel("返回文件树", { exact: true })
        .click(),
    ]);
    assert.equal(
      fileDiscardDialog,
      "confirm",
      "Web 文件草稿放弃操作必须使用可取消的确认框",
    );
    assert.equal(
      await page.getByTestId("file-editor").inputValue(),
      recoveredDraft,
      "取消放弃文件草稿后必须留在编辑器并保留内容",
    );
    await page
      .getByTestId("files-panel")
      .getByLabel("保存", { exact: true })
      .click();
    await page
      .getByTestId("file-editor")
      .fill(`${recoveredDraft}\nMOBILE_FORCE_CONFLICT\n`);
    await page
      .getByTestId("files-panel")
      .getByLabel("保存", { exact: true })
      .click();
    await page
      .getByTestId("file-conflict-banner")
      .waitFor({ state: "visible", timeout: 10_000 });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("file-conflict-overwrite").click();
    await page
      .getByTestId("file-conflict-banner")
      .waitFor({ state: "hidden", timeout: 10_000 });
    await page
      .getByTestId("files-panel")
      .getByText(/^已保存 · Ln /)
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.match(
      await page.getByTestId("file-editor").inputValue(),
      /MOBILE_FORCE_CONFLICT/,
      "确认覆盖后应采用最新 revision 保存并保留当前编辑器内容",
    );
    await page
      .getByTestId("files-panel")
      .getByLabel("返回文件树", { exact: true })
      .click();
    await page
      .getByRole("button", { name: "文件 mobile-preview.png", exact: true })
      .click();
    await page
      .getByTestId("file-image-preview")
      .waitFor({ state: "visible", timeout: 10_000 });
    const workspacePreviewImage = page
      .getByTestId("file-image-preview")
      .locator("img");
    assert.match(
      (await workspacePreviewImage.getAttribute("src")) ?? "",
      /^data:image\/png;base64,/,
      "Files 应通过二进制分块 RPC 正确预览常见工作区图片",
    );
    await capture(page, context, "files-image-preview.png");
    await selectWorkspaceTab("agent");
    await page
      .getByTestId("message-attachment-mobile-preview.png")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-attachment-mobile-preview.png").click();
    await page
      .getByTestId("attachment-lightbox-image")
      .waitFor({ state: "visible", timeout: 10_000 });
    const previewImage = page
      .getByTestId("attachment-lightbox-image")
      .locator("img");
    const previewSource = await (
      (await previewImage.count())
        ? previewImage
        : page.getByTestId("attachment-lightbox-image")
    ).getAttribute("src");
    assert.match(
      previewSource ?? "",
      /^data:image\/png;base64,/,
      "历史图片附件应通过受限 RPC 读取并显示为灯箱",
    );
    await page
      .getByTestId("attachment-lightbox-backdrop")
      .click({ position: { x: 4, y: 4 } });
    await page
      .getByTestId("attachment-lightbox-image")
      .waitFor({ state: "hidden", timeout: 10_000 });
    await page.getByLabel("更多", { exact: true }).click();
    let deleteTaskDialog = null;
    const dismissTaskDelete = new Promise((resolveDialog) =>
      page.once("dialog", async (dialog) => {
        deleteTaskDialog = dialog.type();
        await dialog.dismiss();
        resolveDialog();
      }),
    );
    await Promise.all([
      dismissTaskDelete,
      page.getByText("删除任务", { exact: true }).click(),
    ]);
    assert.equal(
      deleteTaskDialog,
      "confirm",
      "永久删除任务前必须在 Web 端给出可取消确认框",
    );
    await page
      .getByText("任务操作", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByLabel("关闭", { exact: true }).click();
    await capture(page, context, "conversation.png");

    await page.goto(
      `${gateway.baseUrl}/h/${encodeURIComponent(profileId)}/task/local/archived-mobile-task?cwd=${encodeURIComponent(appRoot)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByTestId("unarchive-task")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page.getByTestId("message-input-root").count(),
      0,
      "归档任务必须隐藏消息输入区并保持只读",
    );
    await page.getByTestId("unarchive-task").click();
    await page
      .getByTestId("message-input-root")
      .waitFor({ state: "visible", timeout: 10_000 });

    const missingProfile = "missing-mobile-gateway";
    await page.goto(`${gateway.baseUrl}/h/${missingProfile}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByText("Gateway 已不存在", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.goto(`${gateway.baseUrl}/new?profileId=${missingProfile}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByText("Gateway 已不存在", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.goto(
      `${gateway.baseUrl}/open-project?profileId=${missingProfile}`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByText("Gateway 已不存在", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.goto(
      `${gateway.baseUrl}/h/${encodeURIComponent(profileId)}/task/missing-server/missing-thread`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByText("这个任务链接指向不存在或已移除的 KCoder 服务器。", {
        exact: true,
      })
      .waitFor({ state: "visible", timeout: 30_000 });

    const deepLinkContext = await chromium.browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const deepLinkPage = await deepLinkContext.newPage();
    await deepLinkPage.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await deepLinkPage.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      deepLinkPage.waitForSelector(
        '[data-testid="welcome-direct-connection"]',
        { timeout: 30_000 },
      ),
      deepLinkPage.locator('button[type="submit"]').click(),
    ]);
    const pairingUrl = `${gateway.baseUrl}/connect?gateway=${encodeURIComponent(gateway.baseUrl)}&token=${encodeURIComponent(gateway.authToken)}`;
    await deepLinkPage.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await deepLinkPage
      .getByTestId("new-workspace")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.match(
      deepLinkPage.url(),
      /\/h\//,
      "the pairing deep link should exchange the mobile session and enter the gateway home page automatically",
    );
    const pairedProfileId = decodeURIComponent(
      new URL(deepLinkPage.url()).pathname.split("/").filter(Boolean)[1] ?? "",
    );
    assert.ok(pairedProfileId, "配对后的首页应包含 profileId");
    await deepLinkPage.goto(`${gateway.baseUrl}/connect`, {
      waitUntil: "domcontentloaded",
    });
    await deepLinkPage
      .getByText("配对链接缺少 Gateway 地址或 access token。")
      .waitFor({ state: "visible", timeout: 10_000 });

    const assertColdDeepLinkBack = async (path, readySelector) => {
      const coldPage = await deepLinkContext.newPage();
      await coldPage.goto(`${gateway.baseUrl}${path}`, {
        waitUntil: "domcontentloaded",
      });
      await coldPage
        .locator(readySelector)
        .waitFor({ state: "visible", timeout: 30_000 });
      await coldPage.getByLabel("返回", { exact: true }).first().click();
      await coldPage
        .getByTestId("new-workspace")
        .waitFor({ state: "visible", timeout: 30_000 });
      assert.match(
        coldPage.url(),
        new RegExp(`/h/${pairedProfileId}(?:$|[?/#])`),
        `冷启动深层链接 ${path} 的返回按钮应进入当前 Gateway 首页`,
      );
      await coldPage.close();
    };
    await assertColdDeepLinkBack(
      "/settings",
      '[data-testid="terminal-settings"]',
    );
    await assertColdDeepLinkBack(
      `/sessions?profileId=${encodeURIComponent(pairedProfileId)}`,
      '[aria-label="返回"]',
    );
    await assertColdDeepLinkBack(
      "/host-details?serverId=local",
      '[data-testid="host-details-route"]',
    );
    const reauthPage = await deepLinkContext.newPage();
    await reauthPage.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await reauthPage.evaluate(() => {
      const key = "kcoder-studio-mobile.gateway-profiles.v2";
      const index = JSON.parse(localStorage.getItem(key) || "{}");
      index.profiles = Array.isArray(index.profiles)
        ? index.profiles.map((profile) => ({
            ...profile,
            expiresAt: Date.now() - 1_000,
          }))
        : [];
      localStorage.setItem(key, JSON.stringify(index));
    });
    await reauthPage.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await reauthPage
      .getByRole("dialog", { name: "直接连接", exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await reauthPage.getByTestId("gateway-endpoint").inputValue(),
      gateway.baseUrl,
      "过期会话应打开预填原 Gateway 地址的重新授权界面",
    );
    await reauthPage.getByTestId("gateway-token").fill(gateway.authToken);
    await reauthPage.getByTestId("gateway-connect").click();
    await reauthPage
      .getByTestId("new-workspace")
      .waitFor({ state: "visible", timeout: 30_000 });
    const reauthorizedProfileId = decodeURIComponent(
      new URL(reauthPage.url()).pathname.split("/").filter(Boolean)[1] ?? "",
    );
    assert.equal(
      reauthorizedProfileId,
      pairedProfileId,
      "同一 Gateway 重新授权必须复用 profile id，保留任务与工作区 UI 状态",
    );
    await reauthPage.close();
    await deepLinkContext.close();

    assert.deepEqual(browserErrors, []);
    return {
      viewport: "390x844",
      authenticatedMobileSession: true,
      streamedConversation: true,
      queuedConversation: true,
      taskModelSwitching: true,
      approvalRoundTrip: true,
      questionRoundTrip: true,
      terminalRoundTrip: true,
      terminalCloseGuard: true,
      browserFrame: true,
      browserHistoryNavigation: true,
      changesOpenFile: true,
      fileDraftRecovered: true,
      fileLineNumbersScroll: true,
      historicalAttachmentPreview: true,
      pairingDeepLink: true,
      expiredSessionReauthorization: true,
      coldDeepLinkBack: true,
      serverEditorDirtyGuard: true,
      destructiveActionGuards: true,
      invalidDeepLinks: true,
      archivedTaskRecovery: true,
      browserErrors,
    };
  },
);

async function capture(page, context, filename) {
  const path = context.pathInCase("system-chromium", "mobile-web", filename);
  await mkdir(resolve(path, ".."), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
