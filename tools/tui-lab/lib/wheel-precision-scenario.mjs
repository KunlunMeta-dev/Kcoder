import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createRunContext, verifyRunContextIntegrity } from "./run-context.mjs";
import { browserLaunchOptions } from "./runner-options.mjs";
import { submitTerminalLine } from "./terminal-interaction.mjs";
import { captureStep } from "./browser-evidence.mjs";
import {
  runBrowserScenarioLifecycle,
  settleLifecycleStep,
} from "./browser-lifecycle.mjs";

function fixture(kind) {
  const messages = [];
  if (kind === "report") {
    for (let i = 0; i < 80; i++)
      messages.push(
        ["user", `Earlier task ${i}`],
        ["assistant", `Earlier reply ${i}\n\nAnother paragraph.`],
      );
    messages.push(
      [
        "system",
        "[Thinking] Looking up the project\nReviewing the available sources\n" +
          "Hidden reasoning\n".repeat(60),
      ],
      ["system", "[Tool use: grep] project title"],
      ["system", "✓ Tool succeeded: grep - project metadata"],
      ["system", "[Tool use: WebFetch] https://example.com"],
      ["system", "✓ Tool succeeded: WebFetch - sample document"],
      [
        "system",
        "[Thinking] I have everything needed. Now write the answer.\n" +
          "Hidden reasoning\n".repeat(60),
      ],
      [
        "assistant",
        "## 中文报告\n\n| 项目 | 内容 |\n| --- | --- |\n" +
          Array.from(
            { length: 8 },
            (_, i) => `| 项目 ${i} | 这是表格内容 ${i} |`,
          ).join("\n") +
          "\n\n" +
          Array.from(
            { length: 45 },
            (_, i) =>
              `报告段落-${i}：这是一个普通中文段落，包含 **Markdown** 和 \`代码引用\`。\n\n- 条目-${i}：short explanatory content`,
          ).join("\n\n"),
      ],
    );
    return historyJsonl(messages, kind);
  }
  for (let i = 0; i < 90; i++) {
    if (kind === "plain") {
      messages.push(
        ["assistant", `ROW-${String(i * 2).padStart(3, "0")}`],
        ["assistant", `ROW-${String(i * 2 + 1).padStart(3, "0")}`],
      );
    } else {
      messages.push(["user", `Task-${i}`]);
      if (kind === "tools")
        messages.push(
          ["system", "[Tool use: read] file.txt"],
          [
            "system",
            `✓ Tool succeeded: read - OUTPUT-${i}\nsecond line\nthird line`,
          ],
          ["system", "[Tool use: bash] task"],
          ["system", `✗ Tool failed: bash - FAILURE-${i}\nreason`],
        );
      messages.push([
        "assistant",
        `### Answer-${i}\n\n| Field | Value |\n| --- | --- |\n| Item | Value-${i} |\n\n\`\`\`text\nCODE-${i}-A\nCODE-${i}-B\n\`\`\`\n\n中文长段落-${i} with word-aware wrapping across several visual rows.`,
      ]);
    }
  }
  return historyJsonl(messages, kind);
}

function historyJsonl(messages, kind) {
  let toolId;
  return (
    messages
      .map(([role, text], i) => {
        let content = [{ type: "text", text }];
        if (text.startsWith("[Thinking] ")) {
          role = "assistant";
          content = [
            { type: "thinking", thinking: text.slice("[Thinking] ".length) },
          ];
        } else if (text.startsWith("[Tool use: ")) {
          role = "assistant";
          toolId = `wheel-${kind}-tool-${i}`;
          const name = /^\[Tool use: ([^\]]+)\]/.exec(text)[1];
          content = [
            { type: "tool_use", id: toolId, name, input: { fixture: true } },
          ];
        } else if (/^[✓✗] Tool (succeeded|failed):/.test(text)) {
          role = "user";
          content = [
            {
              type: "tool_result",
              tool_use_id: toolId,
              content: [{ type: "text", text }],
              is_error: text.startsWith("✗"),
            },
          ];
        }
        return JSON.stringify({
          session_id: `wheel-${kind}-fixture`,
          uuid: `wheel-${kind}-${i}`,
          parentUuid: i ? `wheel-${kind}-${i - 1}` : null,
          timestamp_ms: 1780000000000 + i,
          role,
          content,
        });
      })
      .join("\n") + "\n"
  );
}

export async function runWheelPrecisionScenario(options, runtime) {
  const artifacts = await createRunContext(
    options,
    "wheel-precision",
    runtime.runContextRuntime(),
  );
  const runOptions = {
    ...options,
    scenario: "full-turn",
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    configHome: artifacts.configHome,
    requestsDir: artifacts.requestsDir,
  };
  const json = (file, value) =>
    writeFile(file, JSON.stringify(value, null, 2) + "\n");
  const samples = [],
    trace = [];
  let session, browser, page;
  const diagnostic = async () => {
    const response = await fetch(new URL("/viewport-diagnostics", page.url()));
    assert.equal(response.ok, true);
    return (await response.json()).latestCommit;
  };
  const bodyRows = async (height) =>
    page.evaluate(
      (height) =>
        window.tuiLab
          .visibleText()
          .split("\n")
          .slice(0, height)
          .map((row) => row.replace(/[│┃]+\s*$/u, "").trimEnd()),
      height,
    );
  return runBrowserScenarioLifecycle({
    execute: async () => {
      await runtime.writeStartMeta(
        artifacts,
        runOptions,
        options.commandOverride,
        "wheel-precision",
      );
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, {
        timeout: options.timeoutMs,
      });
      await page.waitForFunction(
        () => window.tuiLab.visibleText().includes("TUI dev mode"),
        null,
        { timeout: options.timeoutMs },
      );
      const kinds =
        options.scenario === "report"
          ? ["report"]
          : options.scenario === "tools"
            ? ["tools"]
            : ["plain", "rich", "tools"];
      for (const kind of kinds) {
        if (kind === "report")
          await page.setViewportSize({ width: 1840, height: 940 });
        const state = path.join(artifacts.workspace, `wheel-${kind}-fixture`);
        const file = `${state}.jsonl`;
        await mkdir(state, { mode: 0o700 });
        await json(path.join(state, "state.json"), {
          cwd: artifacts.workspace,
          base_cwd: artifacts.workspace,
        });
        await writeFile(file, fixture(kind));
        await submitTerminalLine(page, `/resume ${file}`);
        await writeFile(
          path.join(artifacts.dir, `${kind}-resume-screen.txt`),
          await page.evaluate(() => window.tuiLab.visibleText()),
        );
        await page.waitForFunction(
          (name) => {
            const text = window.tuiLab.visibleText();
            return (
              !text.includes("/resume ") &&
              ((text.includes("Resumed session from") && text.includes(name)) ||
                text.includes("Failed to preflight session"))
            );
          },
          path.basename(file),
          { timeout: 5000 },
        );
        const resumed = await page.evaluate(() => window.tuiLab.visibleText());
        assert.ok(
          resumed.includes("Resumed session from") &&
            resumed.includes(path.basename(file)) &&
            !resumed.includes("Failed to preflight session"),
          "the newly selected synthetic history must resume successfully",
        );
        await page.waitForTimeout(300);
        const footer = (await page.evaluate(() => window.tuiLab.visibleText()))
          .split("\n")
          .at(-1);
        assert.ok(
          !footer.includes("100% context left"),
          "nonempty restored history must not claim a full window",
        );
        if (kind === "report")
          assert.match(
            footer,
            /context left.*\d+(?:\.\d+)?[KM]? \/ \d+(?:\.\d+)?[KM]?/,
            "wide terminal must expose used tokens and its budget",
          );
        for (const expanded of kind === "tools" ? [false, true] : [false]) {
          if (expanded) {
            await page.keyboard.press("Alt+T");
            await page.waitForTimeout(300);
          }
          for (const direction of [-1, 1]) {
            for (
              let event = 0;
              event < (kind === "report" ? 220 : 120);
              event++
            ) {
              const before = await diagnostic();
              if (
                (direction < 0 && before.boundary === "top") ||
                (direction > 0 && before.boundary === "bottom")
              )
                break;
              const previous = await bodyRows(before.viewport_rows);
              assert.equal(
                before.minimum_progress_rows,
                3,
                "candidate must use the requested three-row step",
              );
              const displacement = Math.min(
                3,
                direction < 0
                  ? before.resolved_top
                  : Math.max(
                      0,
                      before.content_rows -
                        before.viewport_rows -
                        before.resolved_top,
                    ),
              );
              const expected =
                direction < 0
                  ? previous.slice(0, -displacement)
                  : previous.slice(displacement);
              await page.evaluate((direction) => {
                const target = document.querySelector(
                  "#terminal .xterm-viewport",
                );
                const bounds = target.getBoundingClientRect();
                target.dispatchEvent(
                  new WheelEvent("wheel", {
                    deltaY: direction * 120,
                    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
                    bubbles: true,
                    cancelable: true,
                    clientX: bounds.x + bounds.width / 2,
                    clientY: bounds.y + bounds.height / 2,
                  }),
                );
              }, direction);
              await page.waitForFunction(
                ({ expected, direction, height, displacement }) => {
                  const rows = window.tuiLab
                    .visibleText()
                    .split("\n")
                    .slice(0, height)
                    .map((row) => row.replace(/[│┃]+\s*$/u, "").trimEnd());
                  return (
                    JSON.stringify(
                      direction < 0
                        ? rows.slice(displacement)
                        : rows.slice(0, -displacement),
                    ) === JSON.stringify(expected)
                  );
                },
                {
                  expected,
                  direction,
                  height: before.viewport_rows,
                  displacement,
                },
                { timeout: 1500 },
              );
              const after = await diagnostic();
              assert.equal(
                after.applied_through_input_sequence,
                before.applied_through_input_sequence + 1,
              );
              const rows = await bodyRows(after.viewport_rows);
              assert.notDeepEqual(rows, previous, "the real screen must move");
              if (event === 20) {
                await page.waitForTimeout(300);
                assert.deepEqual(
                  await bodyRows(after.viewport_rows),
                  rows,
                  "idle re-render must preserve the visible rows",
                );
              }
              samples.push({
                kind,
                expanded,
                direction,
                event,
                displacement,
                first: rows[0],
                last: rows.at(-1),
              });
            }
          }
          await captureStep(
            page,
            trace,
            `${kind}-${expanded ? "expanded" : "collapsed"}`,
            path.join(
              artifacts.dir,
              `${kind}-${expanded ? "expanded" : "collapsed"}.png`,
            ),
          );
        }
      }
      assert.ok(
        samples.length >=
          (options.scenario === "report" || options.scenario === "tools"
            ? 400
            : 500),
        "enough events must cross multiple message boundaries",
      );
      await json(path.join(artifacts.dir, "wheel-samples.json"), samples);
      return {
        preciseEvents: samples.length,
        fixtureKinds: kinds.length,
        report: options.scenario === "report",
        expandedAndCollapsed: kinds.includes("tools"),
        idleStable: true,
        modelRequests: 0,
      };
    },
    captureBeforeCleanup: async () => {
      if (page) {
        await writeFile(
          artifacts.text,
          await page.evaluate(() => window.tuiLab.visibleText()),
        );
        await page.screenshot({
          path: path.join(artifacts.dir, "last-screen.png"),
        });
      }
      if (session) await writeFile(artifacts.ptyLog, session.getPtyLog());
    },
    cleanup: async () => {
      const steps = [];
      if (browser)
        steps.push(await settleLifecycleStep("browser", () => browser.close()));
      if (session)
        steps.push(await settleLifecycleStep("session", () => session.stop()));
      const exit = session
        ? await settleLifecycleStep("pty-exit", () => session.exitPromise)
        : { status: "completed" };
      return { steps, ptyExitObserved: exit.status === "completed" };
    },
    onFailure: async (error) => {
      if (page)
        await page
          .screenshot({ path: path.join(artifacts.dir, "failure.png") })
          .catch(() => {});
      await json(path.join(artifacts.dir, "failure.json"), {
        error: String(error),
        samples,
        trace,
      });
      console.error(artifacts.dir);
    },
    onSuccess: async (result, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await json(artifacts.assertions, { ok: true, ...result });
      await json(artifacts.meta, { ok: true, result, cleanup, trace });
      console.log(artifacts.dir);
    },
  });
}
