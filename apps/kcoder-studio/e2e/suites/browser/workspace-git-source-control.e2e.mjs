import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const execFile = promisify(execFileCallback);

await runE2E(import.meta.url, {
  testId: "workspace-git-source-control-real-repository-user-flow",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway, app-server, and git repositories",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const changedName = `git-changed-${stamp}`;
  const cleanName = `git-clean-${stamp}`;
  const changedFixture = await materializeWorkspace(context, "minimal", { instanceId: "workspace-git-changed" });
  const cleanFixture = await materializeWorkspace(context, "minimal", { instanceId: "workspace-git-clean" });
  const changedWorkspace = resolve(changedFixture.path);
  const cleanWorkspace = resolve(cleanFixture.path);
  const marker = `GIT_SOURCE_CONTROL_${stamp}`;
  const evidence = {
    stage: "setup", marker, steps: [], diffs: [], git: [], projects: [], cleanup: [],
    protocol: [], runtimeTrace: [], providerRequests: null,
    diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] },
  };
  await initRepository(changedWorkspace, "changed baseline");
  await initRepository(cleanWorkspace, "clean baseline");
  await writeFile(resolve(changedWorkspace, "README.md"), `# Minimal fixture\n\nUNSTAGED_${marker}\n`, "utf8");
  await writeFile(resolve(changedWorkspace, "staged-note.txt"), `STAGED_${marker}\n`, "utf8");
  await git(changedWorkspace, "add", "staged-note.txt");
  evidence.git.push({ label: "initial-mixed-status", status: await gitText(changedWorkspace, "status", "--short") });

  const kcoderConfigDir = context.pathInState("kcoder-config");
  await mkdir(kcoderConfigDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("kcoder-config/settings.json", {});
  await context.writeStateJson("kcoder-config/credentials.json", {
    "git-source-control-e2e": { type: "api", key: "deterministic-local-fixture" },
  });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("kcoder-settings.json", {
    active_provider: "git-source-control-e2e",
    providers: {
      "git-source-control-e2e": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "git-source-control-e2e-model",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 8_192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Git Source Control E2E",
    runtime: "kcoder",
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace: changedWorkspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    label: "workspace-git-source-control-gateway",
    workspace: changedWorkspace,
    serversFile,
    auth: true,
    env: { KCODER_CONFIG_DIR: kcoderConfigDir },
  });
  const chromium = await startChromium(context, { label: "workspace-git-source-control-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => localStorage.setItem("wework:debug-runtime", "1"));
  observe(page, evidence);
  const projects = [];
  let changedTaskId = "";
  let failure;

  try {
    await login(page, gateway);
    evidence.stage = "create-projects";
    const changedId = await createProject(page, changedWorkspace, changedName);
    projects.push({ id: changedId, name: changedName });
    const cleanId = await createProject(page, cleanWorkspace, cleanName);
    projects.push({ id: cleanId, name: cleanName });
    evidence.projects.push({ id: changedId, name: changedName, workspace: changedWorkspace }, { id: cleanId, name: cleanName, workspace: cleanWorkspace });
    await selectProject(page, changedId, changedName);

    evidence.stage = "create-conversation";
    const changedProject = byProject(page, changedName);
    await changedProject.hover();
    await changedProject.getByTestId("project-new-conversation-button").click();
    const conversationPrompt = `prepare git review ${marker}`;
    await sendPrompt(page, conversationPrompt);
    await page.getByTestId("message-user").filter({ hasText: conversationPrompt }).last().waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(expected => [...document.querySelectorAll('[data-testid="message-assistant"]')].some(node => node.textContent?.includes(expected)), `deterministic renderer response: ${conversationPrompt}`, { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="thinking-indicator"],[data-testid="pause-response-button"]').length === 0, undefined, { timeout: 15_000 });
    changedTaskId = new URL(page.url()).searchParams.get("taskId") || "";
    assert.ok(changedTaskId.startsWith("kcoder:local:"), `unexpected task id ${changedTaskId}`);
    const assistantCopies = await page.getByTestId("message-assistant").filter({ hasText: `deterministic renderer response: ${conversationPrompt}` }).count();
    evidence.steps.push({ label: "real-conversation-created-for-workspace-toolbar", taskId: changedTaskId, providerRequests: model.requests.length, assistantCopies });
    assert.equal(assistantCopies, 1, "one model turn rendered duplicate assistant messages");

    evidence.stage = "environment-entry";
    const popover = await openEnvironmentPopover(page);
    await popover.getByTestId("environment-git-section").waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await popover.getByTestId("environment-workspace-path-button").getAttribute("title"), new RegExp(escapeRegex(changedWorkspace)));
    assert.match(await popover.innerText(), /变更|Changes/i);
    evidence.steps.push({ label: "environment-entry-shows-real-repository" });
    await shot(page, context, "01-environment-mixed-changes.png");

    evidence.stage = "unstaged-diff";
    await popover.getByTestId("environment-changes-button").click();
    await waitReview(page);
    await selectReviewMode(page, /未暂存|Unstaged/i);
    await exerciseAndExpandReviewFile(page, "README.md");
    const unstagedText = await reviewText(page);
    assert.match(unstagedText, new RegExp(`\\bUNSTAGED_${marker}`));
    assert.doesNotMatch(unstagedText, new RegExp(`(?<!UN)STAGED_${marker}`));
    evidence.diffs.push({ mode: "unstaged", containsUnstaged: true, containsStaged: false });

    evidence.stage = "staged-diff";
    await selectReviewMode(page, /已暂存|Staged/i);
    await exerciseAndExpandReviewFile(page, "staged-note.txt");
    const stagedText = await reviewText(page);
    assert.match(stagedText, new RegExp(`(?<!UN)STAGED_${marker}`));
    assert.doesNotMatch(stagedText, new RegExp(`\\bUNSTAGED_${marker}`));
    evidence.diffs.push({ mode: "staged", containsUnstaged: false, containsStaged: true });
    await shot(page, context, "02-staged-diff.png");

    evidence.stage = "refresh-diff";
    await writeFile(resolve(changedWorkspace, "README.md"), `# Minimal fixture\n\nUNSTAGED_${marker}\nREFRESHED_${marker}\n`, "utf8");
    await selectReviewMode(page, /未暂存|Unstaged/i);
    await page.getByTestId("refresh-review-diff-button").click();
    await waitReviewContains(page, `REFRESHED_${marker}`);
    evidence.steps.push({ label: "mixed-unstaged-staged-diffs-and-refresh" });

    evidence.stage = "clean-project-isolation";
    await openBlankProject(page, cleanName);
    await openReviewWorkspace(page);
    await page.getByTestId("refresh-review-diff-button").click();
    await page.getByTestId("file-changes-review-empty").waitFor({ state: "visible", timeout: 30_000 });
    const cleanReview = await page.getByTestId("file-changes-review-panel").innerText();
    assert.doesNotMatch(cleanReview, new RegExp(marker));
    await page.getByTestId("project-work-button").filter({ hasText: cleanName }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByTestId("environment-info-button").count(), 0, "blank project should not expose task environment popover");
    evidence.steps.push({ label: "clean-project-review-isolated" });

    evidence.stage = "commit-all";
    await openRuntimeTask(page, changedName, changedTaskId);
    await openEnvironmentPopover(page);
    await page.getByTestId("environment-info-popover").getByTestId("environment-commit-button").click();
    const form = page.getByTestId("environment-commit-form");
    await form.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await form.innerText(), /包含未暂存的更改|include unstaged changes/i);
    const message = `test: source control ${stamp}`;
    await form.getByTestId("environment-commit-message-input").fill(message);
    await form.getByTestId("environment-confirm-commit-button").click();
    await form.waitFor({ state: "detached", timeout: 30_000 });
    await waitGitClean(changedWorkspace);
    assert.equal(await gitText(changedWorkspace, "log", "-1", "--pretty=%s"), message);
    evidence.git.push({ label: "after-ui-commit", status: await gitText(changedWorkspace, "status", "--short"), subject: message });
    evidence.steps.push({ label: "commit-all-includes-staged-and-unstaged" });
    await shot(page, context, "03-commit-success.png");

    evidence.stage = "commit-error";
    const commitButton = page.getByTestId("environment-info-popover").getByTestId("environment-commit-button");
    await commitButton.click();
    await page.getByTestId("environment-commit-form").getByTestId("environment-commit-message-input").fill(`test: should fail ${stamp}`);
    await page.getByTestId("environment-commit-form").getByTestId("environment-confirm-commit-button").click();
    const commitError = page.getByTestId("environment-commit-form").getByTestId("environment-commit-error");
    await commitError.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await commitError.innerText(), /nothing to commit|no changes|没有.*提交|无.*更改/i);
    evidence.steps.push({ label: "clean-repository-commit-error-is-visible" });
    await shot(page, context, "04-clean-commit-error.png");
    await page.getByTestId("environment-cancel-commit-button").click();
    await page.getByTestId("environment-commit-form").waitFor({ state: "detached", timeout: 30_000 });

    evidence.stage = "post-commit-review";
    await page.getByTestId("environment-info-popover").getByTestId("environment-changes-button").click();
    await waitReview(page);
    await selectReviewMode(page, /未暂存|Unstaged/i);
    await page.getByTestId("file-changes-review-empty").waitFor({ state: "visible", timeout: 30_000 });
    await selectReviewMode(page, /提交|Last commit|Commit/i);
    await waitReviewContains(page, `STAGED_${marker}`);
    evidence.steps.push({ label: "post-commit-empty-worktree-and-last-commit-diff" });

    evidence.stage = "cleanup";
    for (const project of [...projects].reverse()) {
      await removeProject(page, project.name, project.id);
      evidence.cleanup.push({ kind: "project", ...project, remaining: 0 });
      projects.splice(projects.findIndex(item => item.id === project.id), 1);
    }
    assertDiagnostics(evidence);
    evidence.stage = "passed";
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    evidence.body = (await page.locator("body").innerText().catch(() => "")).slice(0, 12000);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    evidence.providerRequests = {
      count: model.requests.length,
      summaries: model.requests.slice(0, 10).map((request, index) => ({
        index: index + 1,
        model: request?.model ?? null,
        messageCount: Array.isArray(request?.messages) ? request.messages.length : 0,
        roles: Array.isArray(request?.messages) ? request.messages.map(message => message?.role ?? null) : [],
      })),
    };
    if (await page.getByTestId("environment-commit-form").isVisible().catch(() => false)) {
      await page.getByTestId("environment-cancel-commit-button").click().catch(() => undefined);
    }
    for (const project of [...projects].reverse()) {
      try { await removeProject(page, project.name, project.id); evidence.cleanup.push({ kind: "project", ...project, remaining: 0 }); }
      catch (error) { evidence.cleanup.push({ kind: "project", ...project, error: String(error) }); }
    }
    await context.writeArtifactJson("workspace-git-source-control.json", evidence);
  }
  if (failure) throw failure;
  return evidence;
});

async function initRepository(workspace, message) {
  await git(workspace, "init", "-b", "main");
  await git(workspace, "config", "user.name", "KCoder Studio E2E");
  await git(workspace, "config", "user.email", "kcoder-studio-e2e@example.invalid");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", message);
}

async function git(workspace, ...args) { return execFile("git", ["-C", workspace, ...args], { encoding: "utf8" }); }
async function gitText(workspace, ...args) { return (await git(workspace, ...args)).stdout.trim(); }

async function waitGitClean(workspace) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await gitText(workspace, "status", "--short")) === "") return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  assert.equal(await gitText(workspace, "status", "--short"), "");
}

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  const input = page.locator('input[name="token"]');
  if (await input.count()) {
    await input.fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
  }
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
}

async function sendPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-message-input"]')?.getAttribute("contenteditable") === "true", undefined, { timeout: 30_000 });
  await page.keyboard.insertText(prompt);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="send-message-button"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30_000 });
  await page.getByTestId("send-message-button").click();
}

async function createProject(page, workspace, name) {
  await page.getByTestId("projects-create-button").click();
  await page.getByTestId("project-create-local-option").click();
  const picker = page.getByTestId("standalone-folder-project-dialog");
  await picker.waitFor({ state: "visible", timeout: 30_000 });
  const pathInput = picker.getByTestId("device-folder-path-input");
  await pathInput.fill(workspace);
  await pathInput.press("Enter");
  await page.waitForTimeout(300);
  assert.equal(await pathInput.inputValue(), workspace, "目录选择器没有稳定到目标绝对路径");
  await picker.getByTestId("confirm-device-folder-picker-button").click();
  const dialog = page.getByTestId("local-project-create-dialog");
  await dialog.getByTestId("local-project-create-name-input").fill(name);
  await dialog.getByTestId("confirm-local-project-create-button").click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  const testId = await project.locator('[data-testid^="project-row-"]').first().getAttribute("data-testid");
  const id = testId?.replace("project-row-", "") || "";
  assert.match(id, /^\d+$/);
  return id;
}

async function selectProject(page, id, name) {
  await page.getByTestId("project-work-button").first().click();
  await page.getByTestId(`project-option-${id}`).click();
  await page.getByTestId("project-work-button").filter({ hasText: name }).waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(300);
}

async function openBlankProject(page, name) {
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
  await page.getByTestId("project-work-button").filter({ hasText: name }).waitFor({ state: "visible", timeout: 30_000 });
}

async function openRuntimeTask(page, projectName, taskId) {
  const project = byProject(page, projectName);
  const projectButton = project.getByTestId("project-item-button");
  if ((await projectButton.getAttribute("aria-expanded")) !== "true") await projectButton.click();
  const row = page.locator(`[data-testid="runtime-local-task-row-${escapeCss(taskId)}"]:visible`);
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.evaluate(node => node.click());
  await page.waitForURL(url => url.searchParams.get("taskId") === taskId, { timeout: 30_000 });
  await page.getByTestId("environment-info-button").waitFor({ state: "visible", timeout: 30_000 });
}

async function openReviewWorkspace(page) {
  const shell = page.getByTestId("right-workspace-panel-shell");
  if ((await shell.getAttribute("aria-hidden").catch(() => "true")) === "true") await page.getByTestId("toggle-right-workspace-panel-button").click();
  if (await page.getByTestId("file-changes-review-panel").isVisible().catch(() => false)) return;
  if (await page.getByTestId("right-workspace-launcher").isVisible().catch(() => false)) {
    await page.getByTestId("right-workspace-review-option").click();
  } else {
    await page.getByTestId("right-workspace-new-tab-button").click();
    await page.getByTestId("right-workspace-new-tab-menu").getByTestId("right-workspace-review-option").click();
  }
  await waitReview(page);
}

function byProject(page, name) { return page.getByTestId("project-item").filter({ hasText: name }).first(); }

async function removeProject(page, name, id) {
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  await project.hover();
  await page.getByTestId(`project-menu-${id}`).click();
  await page.getByTestId(`remove-project-${id}`).click();
  await page.getByTestId(`remove-project-dialog-${id}-confirm-button`).click();
  await page.locator(`[data-testid="project-row-${id}"]:visible`).waitFor({ state: "detached", timeout: 30_000 });
}

async function waitReview(page) {
  await page.getByTestId("file-changes-review-panel").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("file-changes-review-toolbar").waitFor({ state: "visible", timeout: 30_000 });
}

async function openEnvironmentPopover(page) {
  const popover = page.getByTestId("environment-info-popover");
  if (await popover.isVisible().catch(() => false)) return popover;
  const button = page.getByTestId("environment-info-button");
  await button.waitFor({ state: "visible", timeout: 30_000 });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await popover.waitFor({ state: "visible", timeout: 30_000 });
  return popover;
}

async function selectReviewMode(page, label) {
  await page.getByTestId("review-view-switcher-button").click();
  const menu = page.getByTestId("review-view-switcher-menu");
  await menu.waitFor({ state: "visible", timeout: 30_000 });
  await menu.getByTestId("review-view-switcher-option").filter({ hasText: label }).click();
  await waitReview(page);
  await page.waitForTimeout(250);
}

async function reviewText(page) {
  const lines = page.getByTestId("file-changes-review-diff-lines");
  await lines.waitFor({ state: "visible", timeout: 30_000 });
  return lines.evaluate(root => {
    const light = root.textContent ?? "";
    const shadow = [...root.querySelectorAll("diffs-container")]
      .map(container => container.shadowRoot?.textContent ?? "")
      .join("\n");
    return `${light}\n${shadow}`;
  });
}

async function waitReviewContains(page, text) {
  await page.waitForFunction(expected => {
    const root = document.querySelector('[data-testid="file-changes-review-diff-lines"]');
    if (!root) return false;
    return (root.textContent ?? "").includes(expected) || [...root.querySelectorAll("diffs-container")].some(container => container.shadowRoot?.textContent?.includes(expected));
  }, text, { timeout: 30_000 });
}

async function exerciseAndExpandReviewFile(page, name) {
  const toggle = page.getByTestId("file-changes-review-file-diff-toggle").filter({ hasText: name }).first();
  await toggle.waitFor({ state: "visible", timeout: 30_000 });
  if ((await toggle.getAttribute("aria-expanded")) === "true") {
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  }
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await toggle.locator("xpath=following-sibling::*[1]").waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
}

function observe(page, evidence) {
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", stage: evidence.stage, text: error.message }));
  page.on("console", async message => {
    if (["error", "warning"].includes(message.type())) evidence.diagnostics.console.push({ type: message.type(), stage: evidence.stage, text: message.text() });
    if (!["debug", "info"].includes(message.type()) || !message.text().includes("[KCoder Studio]")) return;
    const args = await Promise.all(message.args().map(argument => argument.jsonValue().catch(() => null)));
    evidence.runtimeTrace.push({ type: message.type(), stage: evidence.stage, text: message.text(), args });
  });
  page.on("response", response => { if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ stage: evidence.stage, status: response.status(), path: new URL(response.url()).pathname }); });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ stage: evidence.stage, error: request.failure()?.errorText, path: new URL(request.url()).pathname }));
  page.on("websocket", socket => {
    socket.on("socketerror", error => evidence.diagnostics.socketErrors.push({ stage: evidence.stage, text: String(error) }));
    socket.on("framereceived", event => captureProtocolFrame(evidence, "received", event.payload));
    socket.on("framesent", event => captureProtocolFrame(evidence, "sent", event.payload));
  });
}

function captureProtocolFrame(evidence, direction, payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? "");
  if (!/(?:turn|item)[/_](?:started|delta|completed)|(?:turn|item)\.(?:started|delta|completed)/i.test(text)) return;
  if (evidence.protocol.length >= 200) return;
  evidence.protocol.push({ stage: evidence.stage, direction, payload: text.slice(0, 4000) });
}

function assertDiagnostics(evidence) {
  assert.deepEqual(evidence.diagnostics.console, []);
  assert.deepEqual(evidence.diagnostics.failedResponses, []);
  assert.deepEqual(evidence.diagnostics.requestFailures, []);
  assert.deepEqual(evidence.diagnostics.socketErrors, []);
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function escapeCss(value) { return value.replace(/["\\]/g, "\\$&"); }

async function shot(page, context, name) {
  const path = context.pathInCase("system-chromium", "workspace-git-source-control", name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
