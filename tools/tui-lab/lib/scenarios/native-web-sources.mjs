import assert from "node:assert/strict";
import path from "node:path";
import { readFile, readlink, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import {
  createRunContext,
  verifyRunContextIntegrity,
} from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import {
  defaultCommandString,
  browserLaunchOptions,
  shellQuote,
} from "../runner-options.mjs";
import { startSession } from "../session.mjs";
import {
  runBrowserScenarioLifecycle,
  cleanupOwnedBrowserSessions,
} from "../browser-lifecycle.mjs";
import { captureFailurePageEvidence } from "../failure-artifact.mjs";
import {
  captureStep,
  attachBrowserConsole,
  formatBrowserConsole,
} from "../browser-evidence.mjs";
import {
  writeStartMeta,
  writeTextArtifact,
  writeJsonArtifact,
  writeFailureArtifacts,
} from "../runtime-artifacts.mjs";
import {
  submitTerminalLine,
  waitForTerminalText,
  pressTerminalEscape,
} from "../terminal-interaction.mjs";
import {
  copyNativeWebBundle,
  snapshotNativeTree,
} from "../native-web-history.mjs";

async function ownedProcessTree(rootPid) {
  const queue = [{ pid: rootPid, parent: null }],
    processes = [];
  while (queue.length) {
    const { pid, parent } = queue.shift();
    try {
      const status = await readFile(`/proc/${pid}/stat`, "utf8"),
        end = status.lastIndexOf(")"),
        fields = status.slice(end + 2).split(" ");
      if (parent !== null && Number(fields[1]) !== parent) continue;
      processes.push({
        pid,
        parentPid: Number(fields[1]),
        command: status.slice(status.indexOf("(") + 1, end),
        startTicks: fields[19],
        state: fields[0],
      });
      const tasks = await readdir(`/proc/${pid}/task`),
        children = new Set();
      assert.ok(
        tasks.length <= 1024,
        "Owned fixture thread enumeration must remain bounded",
      );
      for (let start = 0; start < tasks.length; start += 32) {
        const batches = await Promise.all(
          tasks.slice(start, start + 32).map(async (task) => {
            try {
              return await readFile(
                `/proc/${pid}/task/${task}/children`,
                "utf8",
              );
            } catch (error) {
              if (error.code === "ENOENT" || error.code === "ESRCH") return "";
              throw error;
            }
          }),
        );
        for (const text of batches)
          for (const value of text.trim().split(/\s+/))
            if (value) children.add(Number(value));
      }
      queue.push(
        ...[...children].map((child) => ({ pid: child, parent: pid })),
      );
      assert.ok(
        processes.length + queue.length <= 64,
        "Owned fixture process tree must remain bounded",
      );
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return processes;
}

async function sameOwnedProcess(process) {
  try {
    const status = await readFile(`/proc/${process.pid}/stat`, "utf8"),
      fields = status.slice(status.lastIndexOf(")") + 2).split(" ");
    return fields[19] === process.startTicks;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

export async function runNativeWebSourcesScenario(options) {
  options = {
    ...options,
    historyPath:
      options.historyPath || process.env.KCODER_TUI_LAB_NATIVE_WEB_HISTORY,
    commandOverride:
      options.commandOverride ||
      (process.env.KCODER_TUI_LAB_NATIVE_WEB_BINARY
        ? `exec ${shellQuote(process.env.KCODER_TUI_LAB_NATIVE_WEB_BINARY)} --settings-file {nativeSettings} --cwd {nativeWorkspace} tui-dev --scenario full-turn`
        : undefined),
  };
  assert.ok(
    options.historyPath,
    "--history must select a controlled complete native bundle",
  );
  assert.ok(
    options.commandOverride,
    "--command must pin an actual compiled CLI",
  );
  assert.match(
    options.commandOverride,
    /^exec (?:[A-Za-z0-9_./:-]+|'[^'\r\n]+'|"[^"$`\r\n]+") --settings-file \{nativeSettings\} --cwd \{nativeWorkspace\} tui-dev --scenario full-turn$/,
    "Only the fixture mock model command is allowed",
  );
  const artifacts = await createRunContext(
    options,
    "native-web-sources",
    runContextRuntime(),
  );
  const bundle = await copyNativeWebBundle(
    options.historyPath,
    artifacts.configHome,
  );
  const override = options.commandOverride
    .replaceAll("{nativeSettings}", shellQuote(bundle.launchSettings))
    .replaceAll("{nativeWorkspace}", shellQuote(bundle.workspace));
  const runOptions = {
    ...options,
    scenario: "full-turn",
    runDir: artifacts.dir,
    workspaceDir: bundle.workspace,
    configHome: artifacts.configHome,
    requestsDir: artifacts.requestsDir,
    commandOverride: override,
    steerAfterTool: true,
  };
  const command = defaultCommandString(runOptions),
    trace = [],
    browserConsole = [],
    screens = [],
    checks = [];
  const sessions = [];
  let session,
    browser,
    page,
    binaryIdentity,
    integrity,
    toolProcessesBeforeCancel = [],
    toolProcessesAfterCancel = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail });
    assert.ok(ok, name);
  };
  const visible = () => page.evaluate(() => window.tuiLab.visibleText());
  const input = (text) =>
    page.evaluate((text) => window.tuiLab.sendInput(text), text);
  const capture = async (name) => {
    const file = path.join(artifacts.dir, name + ".png");
    await captureStep(page, trace, name, file);
    const text = await visible();
    const response = await fetch(new URL("/viewport-diagnostics", session.url));
    assert.ok(
      response.ok,
      "Owned terminal viewport diagnostics must remain readable",
    );
    const viewport = (await response.json()).latestCommit;
    const sourceRows = text
      .split("\n")
      .slice(0, viewport?.viewport_rows || 0)
      .filter((row) =>
        /受控示例|Summary only|Retrieved:|example\.com\/kcoder-owned/.test(row),
      );
    screens.push({ name, text, sourceRows, viewport });
    await writeTextArtifact(path.join(artifacts.dir, name + ".txt"), text);
    return text;
  };
  await writeStartMeta(artifacts, runOptions, command, "native-web-sources");
  await writeJsonArtifact(
    path.join(artifacts.dir, "native-bundle-input.json"),
    {
      history: bundle.sourceHistory,
      privateHistory: bundle.history,
      workspace: bundle.workspace,
      files: bundle.sourceBefore,
      workspaceBefore: bundle.workspaceBefore,
      sourceIds: bundle.facts.sourceIds,
      receipts: bundle.facts.receipts,
      messages: bundle.facts.messages,
      launchSettingsFixtureBudgetFields:
        bundle.launchSettingsFixtureBudgetFields,
    },
  );
  return runBrowserScenarioLifecycle({
    execute: async () => {
      session = await startSession(runOptions);
      sessions.push(session);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 1280, height: 920 } });
      attachBrowserConsole(page, browserConsole);
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, {
        timeout: options.timeoutMs,
      });
      await waitForTerminalText(
        page,
        "TUI dev mode is running mock scenario",
        options.timeoutMs,
      );
      assert.equal(
        process.platform,
        "linux",
        "This retained native cwd replay currently proves Linux only",
      );
      const executable = await readlink(`/proc/${session.ptyProcess.pid}/exe`),
        info = await stat(`/proc/${session.ptyProcess.pid}/exe`),
        hash = createHash("sha256");
      for await (const chunk of createReadStream(
        `/proc/${session.ptyProcess.pid}/exe`,
      ))
        hash.update(chunk);
      binaryIdentity = {
        path: executable,
        pid: session.ptyProcess.pid,
        bytes: info.size,
        sha256: hash.digest("hex"),
      };
      await writeJsonArtifact(
        path.join(artifacts.dir, "actual-binary.json"),
        binaryIdentity,
      );
      check(
        "actual-webgl",
        await page.evaluate(() => window.tuiLab.renderer === "webgl"),
      );
      await capture("01-welcome");
      await submitTerminalLine(page, `/resume ${bundle.history}`);
      await page.waitForFunction(
        () =>
          /Resumed session from|Failed to (preflight|resume)/.test(
            window.tuiLab?.text() || "",
          ),
        null,
        { timeout: options.timeoutMs },
      );
      const resumed = await capture("02-restored-tail");
      check(
        "native-resume-succeeded",
        resumed.includes("Resumed session from") &&
          !resumed.includes("Failed to preflight"),
      );
      await page.keyboard.press("Alt+T");
      await page.waitForTimeout(300);
      await input("\u001b[1;5F");
      await page.waitForTimeout(200);
      let text = await capture("03-expanded-tail"),
        last = "";
      for (let index = 0; index < 30; index++) {
        if (text === last) break;
        last = text;
        await page.keyboard.press("PageUp");
        await page.waitForTimeout(100);
        text = await capture(`04-history-up-${String(index).padStart(2, "0")}`);
      }
      const expanded = screens.map((screen) => screen.text).join("\n");
      check("search-summary-only-rendered", expanded.includes("Summary only"));
      check("fetch-read-rendered", /受控示例原文.*Read/.test(expanded));
      check(
        "real-source-url-rendered",
        bundle.facts.urls.some((url) => expanded.includes(url)),
      );
      check(
        "all-native-observations-readable",
        bundle.facts.sources.every(
          (source) =>
            expanded.includes(source.title) && expanded.includes(source.url),
        ),
      );
      check(
        "scroll-changed-real-body",
        new Set(
          screens
            .filter((screen) => screen.name.startsWith("04-"))
            .map((screen) => JSON.stringify(screen.sourceRows)),
        ).size > 1,
      );
      await input("\u001b[1;5F");
      await page.waitForTimeout(150);
      const beforeFold = await capture("05-expanded-bottom");
      await page.keyboard.press("Alt+T");
      await page.waitForTimeout(200);
      const folded = await capture("06-folded-bottom");
      check("fold-changes-rendered-body", beforeFold !== folded);
      check(
        "fold-hides-expanded-native-sources",
        !folded.includes("Summary only") &&
          !folded.includes("受控示例原文 · Read"),
      );
      await page.keyboard.press("Alt+T");
      await page.waitForTimeout(200);
      for (const [label, size] of [
        ["narrow", { width: 640, height: 720 }],
        ["wide", { width: 1380, height: 980 }],
        ["restored", { width: 1280, height: 920 }],
      ]) {
        await page.setViewportSize(size);
        await page.waitForTimeout(350);
        await input("\u001b[1;5F");
        await page.waitForTimeout(150);
        const frame = await capture(`07-resize-${label}`);
        check(
          `resize-${label}-retains-conversation`,
          /WebFetch|WebSearch|受控/.test(frame),
        );
      }
      // The retained imported context belongs to its original profile; review never re-signs it.
      await submitTerminalLine(page, "/new");
      await waitForTerminalText(
        page,
        "Conversation cleared. Type /help",
        options.timeoutMs,
      );
      await capture("08-current-profile-new-session");
      await submitTerminalLine(page, "/permission ask");
      await waitForTerminalText(
        page,
        "Permission mode set to: Ask",
        options.timeoutMs,
      );
      await submitTerminalLine(page, "tui-lab-native-source-stop-owned-turn");
      await waitForTerminalText(
        page,
        "Yes, and allow for this session",
        options.timeoutMs,
      );
      await capture("09-owned-tool-approval");
      await input("y");
      for (let attempt = 0; attempt < 20; attempt++) {
        toolProcessesBeforeCancel = (
          await ownedProcessTree(session.ptyProcess.pid)
        ).filter((process) => process.pid !== session.ptyProcess.pid);
        if (
          toolProcessesBeforeCancel.some(
            (process) => process.command === "sleep",
          )
        )
          break;
        await page.waitForTimeout(100);
      }
      await writeJsonArtifact(
        path.join(artifacts.dir, "owned-tool-before-cancel.json"),
        toolProcessesBeforeCancel,
      );
      check(
        "actual-owned-sleep-process-running",
        toolProcessesBeforeCancel.some(
          (process) => process.command === "sleep",
        ),
      );
      await page.keyboard.press("Alt+T");
      await page.waitForTimeout(150);
      const active = await capture("10-owned-tool-running");
      check(
        "actual-owned-tool-running-before-cancel",
        active.includes("esc interrupt") && /bash/i.test(active),
      );
      await pressTerminalEscape(page, process.platform);
      await waitForTerminalText(page, "Cancelled.", options.timeoutMs);
      await page.waitForTimeout(350);
      for (let attempt = 0; attempt < 50; attempt++) {
        toolProcessesAfterCancel = [];
        for (const process of toolProcessesBeforeCancel)
          if (await sameOwnedProcess(process))
            toolProcessesAfterCancel.push(process);
        if (!toolProcessesAfterCancel.length) break;
        await page.waitForTimeout(100);
      }
      check(
        "owned-tool-processes-reaped-after-cancel",
        toolProcessesAfterCancel.length === 0,
      );
      await writeJsonArtifact(
        path.join(artifacts.dir, "owned-tool-after-cancel.json"),
        toolProcessesAfterCancel,
      );
      const stopped = await capture("11-stopped");
      check(
        "stopped-without-active-tool-spinner",
        !stopped.includes("esc interrupt") &&
          !stopped.includes("Running tool:") &&
          !stopped.toLowerCase().includes("bash running") &&
          !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(stopped),
      );
      check(
        "interrupted-tool-result-visible",
        stopped.includes("Tool call was interrupted"),
      );
      await input("owned-input-after-stop");
      await page.waitForTimeout(120);
      check(
        "composer-responsive-after-stop",
        (await visible()).includes("owned-input-after-stop"),
      );
      await input("\u0015");
      await submitTerminalLine(page, `/resume ${bundle.history}`);
      await waitForTerminalText(
        page,
        "Resumed session from",
        options.timeoutMs,
      );
      await page.keyboard.press("Alt+T");
      await input("\u001b[1;5F");
      await page.waitForTimeout(250);
      let restored = await capture("12-native-history-after-owned-cancel");
      if (!restored.includes("Summary only")) {
        await page.keyboard.press("Alt+T");
        await page.waitForTimeout(200);
        restored = await capture(
          "13-native-history-expanded-after-owned-cancel",
        );
      }
      check(
        "native-history-stays-settled-after-peer-session-cancel",
        restored.includes("Summary only") &&
          restored.includes("受控示例原文") &&
          restored.includes("Read") &&
          !restored.includes("Running tool:") &&
          !restored.includes("esc interrupt"),
      );
      return { screens, checks };
    },
    captureBeforeCleanup: () => captureFailurePageEvidence({ page }),
    cleanup: async () => {
      const cleanup = await cleanupOwnedBrowserSessions({ browser, sessions });
      const sourceAfter = await snapshotNativeTree(bundle.sourceRoot),
        workspaceAfter = await snapshotNativeTree(bundle.workspace);
      integrity = {
        sourceAfter,
        workspaceAfter,
        originalBundleUnchanged:
          JSON.stringify(sourceAfter) === JSON.stringify(bundle.sourceBefore),
        retainedWorkspaceUnchanged:
          JSON.stringify(workspaceAfter) ===
          JSON.stringify(bundle.workspaceBefore),
      };
      await writeJsonArtifact(
        path.join(artifacts.dir, "native-bundle-integrity.json"),
        integrity,
      );
      await writeJsonArtifact(
        path.join(artifacts.dir, "native-observations.json"),
        screens.map(({ name, sourceRows, viewport }) => ({
          name,
          sourceRows,
          viewport,
        })),
      );
      return cleanup;
    },
    onFailure: async (error, pageEvidence) => {
      await writeJsonArtifact(artifacts.assertions, {
        ok: false,
        checks,
        error: error.message,
      });
      await writeFailureArtifacts({
        artifacts,
        runOptions,
        command,
        mode: "native-web-sources",
        session,
        page,
        browserConsole,
        trace,
        error,
        repoRoot,
        pageEvidence,
      });
    },
    onSuccess: async (result, cleanup) => {
      const { sourceAfter, workspaceAfter } = integrity;
      check(
        "original-bundle-bytes-unchanged",
        JSON.stringify(sourceAfter) === JSON.stringify(bundle.sourceBefore),
      );
      check(
        "retained-workspace-bytes-unchanged",
        JSON.stringify(workspaceAfter) ===
          JSON.stringify(bundle.workspaceBefore),
      );
      await verifyRunContextIntegrity(artifacts, runContextRuntime());
      await writeTextArtifact(
        artifacts.text,
        screens
          .map((screen) => `--- ${screen.name} ---\n${screen.text}`)
          .join("\n"),
      );
      await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
      await writeTextArtifact(
        artifacts.browserConsoleLog,
        formatBrowserConsole(browserConsole),
      );
      await writeJsonArtifact(artifacts.assertions, { ok: true, checks });
      await writeJsonArtifact(artifacts.meta, {
        ok: true,
        mode: "native-web-sources",
        command,
        cleanup,
        runDir: artifacts.dir,
        configHome: artifacts.configHome,
        sourceBefore: bundle.sourceBefore,
        sourceAfter,
        workspaceBefore: bundle.workspaceBefore,
        workspaceAfter,
        expectedSourceIds: bundle.facts.sourceIds,
        renderer: "webgl",
        binaryIdentity,
        toolProcessesBeforeCancel,
        toolProcessesAfterCancel,
        trace,
        externalModelCalls: 0,
        cancellationScope:
          "New owned current-profile session; retained foreign-profile imported context is review only",
        transport:
          "actual node-pty / xterm official WebGL / Playwright; tui-dev mock model only",
      });
      console.log(
        JSON.stringify({ ok: true, runDir: artifacts.dir, checks, cleanup }),
      );
    },
  });
}
