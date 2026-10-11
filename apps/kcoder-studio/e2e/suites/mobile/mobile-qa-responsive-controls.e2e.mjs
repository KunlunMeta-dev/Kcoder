import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import {
  configureWebSocketReadyStateProbe,
  installWebSocketReadyStateProbe,
  readWebSocketReadyStateProbe,
} from "../../harness/websocket-ready-state-probe.mjs";
import {
  repoRoot,
  requireExecutable,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const widths = [360, 390, 414];
const primaryPrompt = "MOBILE_RESPONSIVE_LAYOUT_BOOTSTRAP";
const queuedPrompt = "MOBILE_RESPONSIVE_LAYOUT_QUEUED";
const shortViewportPrompt = "MOBILE_RESPONSIVE_SHORT_VIEWPORT_SEND";
const shortViewportResponse = "MOBILE_RESPONSIVE_SHORT_VIEWPORT_SEND_ACK";
const freshNotSentPrompt = "MOBILE_RESPONSIVE_FRESH_NOT_SENT_RETRY";
const uncertainPrompt = "MOBILE_RESPONSIVE_LAYOUT_ACCEPTED_ACK_LOST";
const uncertainResponse = "MOBILE_RESPONSIVE_LAYOUT_ACCEPTED_ACK_LOST_ACK";
const failedPrompt = "MOBILE_RESPONSIVE_LAYOUT_FAILED_DRAFT";
const retriedPrompt = "MOBILE_RESPONSIVE_LAYOUT_FAILED_DRAFT";
const dismissedPrompt = "MOBILE_RESPONSIVE_LAYOUT_FAILED_DRAFT_DISMISS";
const retryEdgePrompts = ["top", "bottom", "left", "right"].map(
  (edge) => `MOBILE_RESPONSIVE_RETRY_EDGE_${edge.toUpperCase()}`,
);
const dismissEdgePrompts = ["top", "bottom", "left", "right"].map(
  (edge) => `MOBILE_RESPONSIVE_DISMISS_EDGE_${edge.toUpperCase()}`,
);
const tableMarker = "MOBILE_LAYOUT_TABLE_CELL";
const markdownMarker = "MOBILE_LAYOUT_MARKDOWN_SENTINEL";
const toolMarkerPrefix = "MOBILE_LAYOUT_TOOL_LINE_";
const toolId = "mobile-layout-read";

const tableRows = Array.from({ length: 16 }, (_, index) => {
  const row = String(index + 1).padStart(2, "0");
  return "| " + tableMarker + " " + row + " | column-" + row + " | " +
    "wide-cell-" + row + "-" + "x".repeat(42) + " |";
}).join("\n");
const codeLines = Array.from({ length: 120 }, (_, index) =>
  "const responsiveLine" + String(index + 1).padStart(3, "0") +
  " = \"" + "code-fragment-".repeat(5) + index + "\";",
).join("\n");
const markdownResponse = [
  "# Responsive transcript fixture",
  "",
  "This deterministic local Provider fixture is for Mobile Web layout only.",
  "",
  "| section | label | long cell |",
  "| --- | --- | --- |",
  tableRows,
  "",
  String.fromCharCode(96).repeat(3) + "typescript",
  codeLines,
  String.fromCharCode(96).repeat(3),
  "",
  markdownMarker,
].join("\n");

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-responsive-layout-touch-controls",
    tier: "full-integration",
    modelPolicy:
      "model-independent responsive UI fixture; real Mobile Web, Gateway and Rust app-server; deterministic local Provider requests trigger one read-only app-server tool; no real-provider or model-selection claim",
    retainSuccessLogs: true,
  },
  async (context) => {
    const suiteSourceSha256AtStart = await sha256File(new URL(import.meta.url));
    const binarySource = await requireExecutable(
      process.env.KCODER_E2E_KCODER_BIN ||
        resolve(repoRoot, "target/kcoder-relay/bin/kcoder"),
      "isolated KCoder app-server binary",
    );
    const binaryDir = context.pathInState("bin");
    await mkdir(binaryDir, { recursive: true, mode: 0o700 });
    const binary = resolve(binaryDir, "kcoder");
    const binarySourceSha256 = await sha256File(binarySource);
    await copyFile(binarySource, binary);
    await chmod(binary, 0o700);
    const binarySha256 = await sha256File(binary);
    assert.equal(binarySha256, binarySourceSha256, "the run-owned app-server executable must match the explicitly selected build");
    const binarySourceSha256AfterCopy = await sha256File(binarySource);
    assert.equal(binarySourceSha256AfterCopy, binarySha256, "the source executable must not change while its isolated copy is prepared");
    const binaryProvenance = {
      selectedBinaryPath: binarySource,
      sourceSha256BeforeCopy: binarySourceSha256,
      ownedCopySha256: binarySha256,
      sourceSha256AfterCopy: binarySourceSha256AfterCopy,
      sourceUnchangedDuringCopy: binarySourceSha256AfterCopy === binarySourceSha256,
    };
    await context.writeArtifactJson("app-server-binary-provenance.json", binaryProvenance);
    const webExport = await exportMobileWeb(context, {
      label: "mobile-responsive-export",
      outputName: "mobile-web-export",
      dependencyRoot: resolve(
        repoRoot,
        "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules",
      ),
    });
    await preserveMobileWebEntryArtifact(context, webExport);
    const binarySourceSha256AfterExport = await sha256File(binarySource);
    assert.equal(
      binarySourceSha256AfterExport,
      binarySourceSha256,
      "the selected app-server build must remain unchanged through Mobile Web export",
    );
    binaryProvenance.sourceSha256AfterExport = binarySourceSha256AfterExport;
    binaryProvenance.sourceUnchangedThroughExport =
      binarySourceSha256AfterExport === binarySourceSha256;
    await context.writeArtifactJson("app-server-binary-post-export-provenance.json", binaryProvenance);
    const mobileDist = webExport.path;

    const { path: workspace } = await materializeWorkspace(
      context,
      "minimal",
      { instanceId: "mobile-responsive-layout" },
    );
    const toolFile = resolve(workspace, "src/mobile-layout-tool-output.txt");
    await mkdir(resolve(workspace, "src"), { recursive: true });
    const toolOutput = Array.from({ length: 120 }, (_, index) => {
      const line =
        toolMarkerPrefix +
        String(index + 1).padStart(3, "0") +
        " " +
        ("tool-detail-fragment-".repeat(7) + String(index + 1));
      return line;
    }).join("\n") + "\n";
    await writeFile(toolFile, toolOutput, "utf8");

    let releaseReadTool = false;
    const model = await startApprovalModelFixture(context, {
      responseSteps: ({ body }) => {
        const lastUserMessage = [...(body.messages ?? [])]
          .reverse()
          .find((message) => message?.role === "user");
        const lastUserContent = JSON.stringify(lastUserMessage?.content ?? "");
        if (
          lastUserContent.includes(freshNotSentPrompt) ||
          retryEdgePrompts.some((prompt) => lastUserContent.includes(prompt)) ||
          dismissEdgePrompts.some((prompt) => lastUserContent.includes(prompt))
        ) {
          return [
            { delta: { role: "assistant", content: "MOBILE_RESPONSIVE_TOUCH_ACK" } },
            { finishReason: "stop" },
          ];
        }
        const hasShortViewportPrompt = lastUserContent.includes(shortViewportPrompt);
        if (hasShortViewportPrompt) {
          return [
            { delta: { role: "assistant", content: shortViewportResponse } },
            { finishReason: "stop" },
          ];
        }
        const hasUncertainPrompt = lastUserContent.includes(uncertainPrompt);
        if (hasUncertainPrompt) {
          return [
            { delta: { role: "assistant", content: uncertainResponse } },
            { finishReason: "stop" },
          ];
        }
        const hasToolResult = (body.messages ?? []).some(
          (message) => message?.role === "tool",
        );
        if (hasToolResult) {
          return [
            { delta: { role: "assistant", content: markdownResponse } },
            { finishReason: "stop" },
          ];
        }
        return [
          {
            delta: {
              role: "assistant",
              content: "MOBILE_LAYOUT_TOOL_PENDING",
            },
          },
          {
            ready: () => releaseReadTool,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: toolId,
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({
                      file_path: toolFile,
                      offset: 1,
                      limit: 120,
                    }),
                  },
                },
              ],
            },
          },
          { finishReason: "tool_calls" },
        ];
      },
    });

    const configDir = context.pathInState("config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const settingsFile = await context.writeStateJson(
      "responsive-provider-settings.json",
      {
        active_provider: "mobile-layout-beta",
        permission_mode: "yolo",
        max_retries: 0,
        providers: {
          "mobile-layout-alpha": provider(model.baseUrl, "mobile-layout-alpha-model"),
          "mobile-layout-beta": provider(model.baseUrl, "mobile-layout-beta-model"),
        },
      },
    );
    await context.writeStateJson("config/settings.json", {});
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Mobile Layout Fixture",
        transport: "local",
        command: binary,
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-responsive-gateway",
      workspace,
      serversFile,
      kcoderBin: binary,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_WEB_ROOT: mobileDist,
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-responsive-chromium",
    });
    const page = await chromium.newPage({
      viewport: { width: 360, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const pageErrors = [];
    const consoleErrors = [];
    const acceptanceFault = createAcceptanceFaultState();
    const responsiveStages = [];
    const touchTargets = {};
    const faultInjection = {};
    let browserResizeControlAudit = null;
    let keyboardAudit = null;
    let keyboardState = null;
    let actualAppServerProvenance = null;
    let readyStateProbeInstallationAudit = null;
    installResponsiveWebSocketFaultRoute(page, acceptanceFault);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    try {
      const resizeControlPage = await chromium.newPage({
        viewport: { width: 360, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      context.addCleanup("close mobile viewport resize control page", () =>
        resizeControlPage.close().catch(() => undefined),
      );
      browserResizeControlAudit = await runViewportResizeControl(resizeControlPage);
      assert.equal(
        browserResizeControlAudit.beforeResize.focused,
        true,
        "the bare textarea must be focused before the viewport-resize control measurement",
      );
      await resizeControlPage.close();
      await connect(page, gateway, async () => {
        await installWebSocketReadyStateProbe(page);
        readyStateProbeInstallationAudit =
          await readWebSocketReadyStateProbe(page);
      });
      readyStateProbeInstallationAudit.afterGatewayConnect =
        await readWebSocketReadyStateProbe(page);
      assert.equal(
        readyStateProbeInstallationAudit.afterGatewayConnect
          .windowConstructorMatchesWrapper,
        true,
        "the page must still use the suite's WebSocket constructor wrapper after the real Gateway connection",
      );
      await page.getByTestId("new-workspace").tap();
      await page.getByTestId("server-option-local").tap();
      const workspacePath = page.getByTestId("workspace-path");
      await workspacePath.waitFor({ state: "visible", timeout: 30_000 });
      await workspacePath.fill(workspace);
      await page.getByTestId("new-workspace-prompt").fill(primaryPrompt);
      await page.getByTestId("create-workspace").tap();
      await page
        .getByTestId("message-user")
        .filter({ hasText: primaryPrompt })
        .waitFor({ state: "visible", timeout: 30_000 });
      await page
        .getByTestId("stop-turn")
        .waitFor({ state: "visible", timeout: 30_000 });
      await waitFor(
        () => model.requests.length === 1,
        30_000,
        "first real app-server request to the local layout fixture",
        50,
        context.abortSignal,
      );
      actualAppServerProvenance = await captureOwnedAppServerProvenance(
        context,
        gateway,
        binary,
        binarySha256,
      );
      await context.writeArtifactJson(
        "actual-app-server-executable-provenance.json",
        actualAppServerProvenance,
      );

      await page.getByTestId("message-input").fill(queuedPrompt + "-remove");
      await page.getByTestId("queue-message").tap();
      const queuedCard = page.getByTestId("queued-message-0");
      await queuedCard.waitFor({ state: "visible", timeout: 10_000 });
      const removeQueued = page.getByLabel("移除排队消息 1", { exact: true });
      touchTargets.queueRemove = await targetGeometry(removeQueued);
      assert.ok(touchTargets.queueRemove.width >= 44);
      assert.ok(touchTargets.queueRemove.height >= 44);
      await removeQueued.tap();
      await queuedCard.waitFor({ state: "hidden", timeout: 10_000 });

      await page.getByTestId("message-input").fill(queuedPrompt);
      await page.getByTestId("queue-message").tap();
      await queuedCard.waitFor({ state: "visible", timeout: 10_000 });
      for (const width of widths) {
        await setViewport(page, width, 844);
        responsiveStages.push(
          await measureViewport(page, width, "queued-card"),
        );
      }
      await page.screenshot({
        path: context.pathInArtifacts("queue-card-360.png"),
      });

      releaseReadTool = true;
      await page
        .getByTestId("tool-call-" + toolId)
        .waitFor({ state: "visible", timeout: 60_000 });
      await page.getByText(markdownMarker, { exact: true }).first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
      await page.getByTestId("send-message").waitFor({
        state: "visible",
        timeout: 60_000,
      });
      await waitFor(
        () => model.requests.length >= 3,
        30_000,
        "queued UI turn to reach the app-server provider boundary",
        50,
        context.abortSignal,
      );
      await page.getByTestId("message-user").filter({ hasText: queuedPrompt }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      await page.getByTestId("send-message").waitFor({
        state: "visible",
        timeout: 60_000,
      });
      assert.equal(await page.getByTestId("queued-messages").count(), 0);

      const readCard = page.getByTestId("tool-call-" + toolId);
      const readToggle = readCard.getByRole("button");
      await readToggle.scrollIntoViewIfNeeded();
      touchTargets.toolDetailToggle = await targetGeometry(readToggle);
      await readToggle.tap();
      const lastToolLine = page.getByText(toolMarkerPrefix + "120", {
        exact: false,
      });
      for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
        if (await lastToolLine.isVisible().catch(() => false)) break;
        const showMore = readCard.getByRole("button", {
          name: /更多|more/i,
        });
        await showMore.tap();
      }
      await lastToolLine.waitFor({ state: "visible", timeout: 20_000 });
      const toolOutputPane = readCard.getByTestId("bounded-output").last();
      const toolOutputScroll = await toolOutputPane.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          atEnd:
            element.scrollHeight - element.clientHeight - element.scrollTop <= 1,
        };
      });
      assert.ok(toolOutputScroll.atEnd, "long tool output must scroll to its final line");
      for (const width of widths) {
        await setViewport(page, width, 844);
        await toolOutputPane.scrollIntoViewIfNeeded();
        const scroll = await toolOutputPane.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return element.scrollHeight - element.clientHeight - element.scrollTop;
        });
        assert.ok(scroll <= 1, "tool output scroll position must remain at its final line");
        responsiveStages.push(
          await measureViewport(page, width, "long-tool-detail"),
        );
        if (width === 360) {
          await page.screenshot({
            path: context.pathInArtifacts("long-tool-detail-360.png"),
          });
        }
      }

      const assistant = page.getByTestId("message-assistant").last();
      const firstTableCell = assistant.getByText(tableMarker + " 01", {
        exact: false,
      });
      await firstTableCell.waitFor({
        state: "visible",
        timeout: 20_000,
      });
      const codeDisclosure = assistant.getByTestId("code-disclosure").first();
      await codeDisclosure.waitFor({ state: "visible", timeout: 20_000 });
      const codeToggle = codeDisclosure.getByRole("button");
      await codeDisclosure.scrollIntoViewIfNeeded();
      await codeToggle.tap();
      const codeOutputPane = codeDisclosure.getByTestId("bounded-output");
      await codeOutputPane.waitFor({ state: "visible", timeout: 10_000 });
      const finalCodeLine = codeOutputPane.getByText("responsiveLine120", {
        exact: false,
      });
      for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
        if (await finalCodeLine.count()) break;
        const showMore = codeDisclosure.getByText("Show more", { exact: true });
        assert.ok(
          await showMore.isVisible().catch(() => false),
          "bounded Markdown code must expose a visible Show more control until line 120 is loaded",
        );
        await showMore.tap();
      }
      await finalCodeLine.waitFor({ state: "visible", timeout: 10_000 });
      for (const width of widths) {
        await setViewport(page, width, 844);
        await firstTableCell.scrollIntoViewIfNeeded();
        const tableVisibility = await transcriptVisibility(firstTableCell);
        assert.ok(
          tableVisibility.intersectsMessageList,
          `the first Markdown table row must be physically in the transcript viewport at ${width}px`,
        );
        const tableStage = await measureViewport(
          page,
          width,
          "long-markdown-table",
        );
        tableStage.firstTableCell = tableVisibility;
        responsiveStages.push(tableStage);
        if (width === 360) {
          await page.screenshot({
            path: context.pathInArtifacts("long-markdown-360.png"),
          });
        }
        await codeDisclosure.scrollIntoViewIfNeeded();
        await codeOutputPane.scrollIntoViewIfNeeded();
        const codeOutputScroll = await codeOutputPane.evaluate((element, marker) => {
          element.scrollTop = element.scrollHeight;
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let markerRect = null;
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const index = node.textContent?.indexOf(marker) ?? -1;
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + marker.length);
            const rect = range.getBoundingClientRect();
            markerRect = {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
            };
            break;
          }
          const paneRect = element.getBoundingClientRect();
          return {
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            atEnd:
              element.scrollHeight - element.clientHeight - element.scrollTop <= 1,
            finalLineRect: markerRect,
            finalLineVisible:
              Boolean(markerRect) &&
              markerRect.bottom > paneRect.top &&
              markerRect.top < paneRect.bottom &&
              markerRect.right > paneRect.left &&
              markerRect.left < paneRect.right,
          };
        }, "responsiveLine120");
        assert.ok(
          codeOutputScroll.atEnd && codeOutputScroll.finalLineVisible,
          "expanded Markdown code must scroll its final fixture line into the bounded output viewport",
        );
        responsiveStages.push(
          await measureViewport(page, width, "expanded-long-markdown-code"),
        );
        if (width === 360) {
          await page.screenshot({
            path: context.pathInArtifacts("long-code-360.png"),
          });
        }
        const list = page.getByTestId("message-list");
        await list.evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.waitForTimeout(100);
        const latestContent = page.getByText(markdownMarker, { exact: true }).last();
        const latestBeforeJump = await transcriptVisibility(latestContent);
        assert.equal(
          latestBeforeJump.intersectsMessageList,
          false,
          `scroll setup must move the final transcript marker out of view at ${width}px`,
        );
        const scrolledToTop = await measureViewport(
          page,
          width,
          "transcript-scrolled-to-top",
        );
        scrolledToTop.latestMarker = latestBeforeJump;
        responsiveStages.push(scrolledToTop);
        const latest = page.getByTestId("jump-to-latest");
        await latest.waitFor({ state: "visible", timeout: 5_000 });
        touchTargets.jumpToLatest = await targetGeometry(latest);
        touchTargets.jumpToLatest.latestMarkerBefore = latestBeforeJump;
        await latest.tap();
        await waitFor(
          async () =>
            (await transcriptVisibility(latestContent)).intersectsMessageList,
          5_000,
          "transcript jump-to-latest touch action to reveal the final message marker",
          50,
          context.abortSignal,
        );
        touchTargets.jumpToLatest.latestMarkerAfter =
          await transcriptVisibility(latestContent);
        if (width === 360) {
          await list.evaluate((element) => {
            element.scrollTop = 0;
          });
          await page.screenshot({
            path: context.pathInArtifacts("long-content-360.png"),
          });
        }
      }

      await setViewport(page, 360, 844);
      const composerSelector = '[data-testid="message-input"]';
      const composer = page.locator(composerSelector);
      await installInputFocusProbe(page, composerSelector);
      await composer.tap();
      await composer.fill("keyboard viewport draft");
      keyboardAudit = {
        boundary:
          "Playwright Chromium mobile emulation viewport resize; no native OS keyboard was opened",
        browserControl: browserResizeControlAudit,
        app: {},
      };
      keyboardAudit.app.beforeResize = await readInputFocusProbe(
        page,
        composerSelector,
        "keyboard viewport draft",
      );
      assert.equal(
        keyboardAudit.app.beforeResize.focused,
        true,
        "the app composer must be focused before the viewport-resize measurement",
      );
      assert.equal(
        keyboardAudit.app.beforeResize.valueMatchesExpected,
        true,
        "the safe diagnostic draft must be present before the viewport-resize measurement",
      );
      await page.setViewportSize({ width: 360, height: 500 });
      await page.waitForFunction(
        () => window.innerWidth === 360 && window.innerHeight === 500,
        undefined,
        { timeout: 5_000 },
      );
      keyboardAudit.app.afterResizeImmediate = await readInputFocusProbe(
        page,
        composerSelector,
        "keyboard viewport draft",
      );
      await waitForResizeStability(page);
      keyboardAudit.app.afterResizeStable = await readInputFocusProbe(
        page,
        composerSelector,
        "keyboard viewport draft",
      );
      keyboardAudit.focusVerdict = resizeFocusVerdict(
        keyboardAudit.app,
        browserResizeControlAudit,
      );
      responsiveStages.push(
        await measureViewport(page, 360, "focused-composer-viewport-shrink"),
      );
      keyboardState = {
        focused: keyboardAudit.app.afterResizeStable.focused,
        draftRetained: keyboardAudit.app.afterResizeStable.valueMatchesExpected,
        visualViewportHeight:
          keyboardAudit.app.afterResizeStable.visualViewportHeight,
        innerHeight: keyboardAudit.app.afterResizeStable.innerHeight,
        composerBottom: keyboardAudit.app.afterResizeStable.composerBottom,
      };
      assert.equal(
        keyboardState.draftRetained,
        true,
        "the composer draft must survive a short-viewport layout change",
      );
      assert.ok(
        keyboardState.composerBottom <= keyboardState.innerHeight + 1,
        "the composer should remain within the shrunken visual viewport",
      );
      const shortViewportInput = page.getByTestId("message-input");
      await shortViewportInput.tap();
      const focusedAfterShortViewportTap = await shortViewportInput.evaluate(
        (element) => document.activeElement === element,
      );
      assert.equal(
        focusedAfterShortViewportTap,
        true,
        "the composer input must accept a real touch after a short-viewport layout change",
      );
      touchTargets.shortViewportComposerInput = await targetGeometry(shortViewportInput);
      touchTargets.shortViewportComposerInput.focusedAfterTouch =
        focusedAfterShortViewportTap;
      const shortViewportSend = page.getByTestId("send-message");
      touchTargets.shortViewportSend = await targetGeometry(shortViewportSend);
      assert.equal(touchTargets.shortViewportSend.width, 44);
      assert.equal(touchTargets.shortViewportSend.height, 44);
      const requestsBeforeShortViewportSend = model.requests.length;
      await shortViewportInput.fill(shortViewportPrompt);
      await shortViewportSend.tap();
      await waitFor(
        () => model.requests.length > requestsBeforeShortViewportSend,
        30_000,
        "short-viewport send control to reach the local provider fixture",
        50,
        context.abortSignal,
      );
      await page.getByText(shortViewportResponse, { exact: true }).last().waitFor({
        state: "visible",
        timeout: 30_000,
      });
      await page.getByTestId("send-message").waitFor({
        state: "visible",
        timeout: 30_000,
      });
      responsiveStages.push(
        await measureViewport(page, 360, "short-viewport-send-completed"),
      );
      await setViewport(page, 360, 844);
      await page.keyboard.press("Escape").catch(() => undefined);

      await page.getByTestId("message-input").fill("");
      const modelSelector = page.getByTestId("conversation-model-selector");
      touchTargets.modelSelector = await targetGeometry(modelSelector);
      assert.ok(touchTargets.modelSelector.height >= 44);
      await modelSelector.tap();
      const modelPicker = page.getByRole("dialog", { name: "切换模型" });
      await modelPicker.waitFor({ state: "visible", timeout: 20_000 });
      const modelOptions = modelPicker.getByRole("radio");
      await waitFor(
        async () => (await modelOptions.count()) >= 2,
        20_000,
        "two model-catalog fixture rows in the visible picker",
        50,
        context.abortSignal,
      );
      for (const width of widths) {
        await setViewport(page, width, 844);
        responsiveStages.push(
          await measureViewport(page, width, "model-picker"),
        );
      }
      await setViewport(page, 360, 844);
      await page.screenshot({
        path: context.pathInArtifacts("model-picker-360.png"),
      });
      touchTargets.modelOption = await targetGeometry(modelOptions.first());
      await modelPicker.getByLabel("关闭").tap();
      await modelPicker.waitFor({ state: "hidden", timeout: 10_000 });
      const modelSelectorBounds = await modelSelector.boundingBox();
      assert.ok(modelSelectorBounds, "the model selector must remain in the short-screen layout");
      const modelSelectorEdges = [
        ["top", modelSelectorBounds.x + modelSelectorBounds.width / 2, modelSelectorBounds.y + 1],
        ["bottom", modelSelectorBounds.x + modelSelectorBounds.width / 2, modelSelectorBounds.y + modelSelectorBounds.height - 1],
        ["left", modelSelectorBounds.x + 1, modelSelectorBounds.y + modelSelectorBounds.height / 2],
        ["right", modelSelectorBounds.x + modelSelectorBounds.width - 1, modelSelectorBounds.y + modelSelectorBounds.height / 2],
      ];
      touchTargets.modelSelector.edgeTaps = [];
      for (const [edge, x, y] of modelSelectorEdges) {
        await page.touchscreen.tap(x, y);
        await modelPicker.waitFor({ state: "visible", timeout: 10_000 });
        touchTargets.modelSelector.edgeTaps.push({ edge, x, y, openedPicker: true });
        await modelPicker.getByLabel("关闭").tap();
        await modelPicker.waitFor({ state: "hidden", timeout: 10_000 });
      }

      await page.getByLabel("打开任务列表", { exact: true }).tap();
      const drawer = page.getByTestId("mobile-drawer");
      await drawer.waitFor({ state: "visible", timeout: 10_000 });
      for (const width of widths) {
        await setViewport(page, width, 844);
        responsiveStages.push(
          await measureViewport(page, width, "mobile-drawer"),
        );
      }
      await setViewport(page, 360, 844);
      await page.screenshot({
        path: context.pathInArtifacts("mobile-drawer-360.png"),
      });
      touchTargets.drawerSettings = await targetGeometry(
        drawer.getByLabel("设置", { exact: true }),
      );
      assert.ok(touchTargets.drawerSettings.width >= 44);
      assert.ok(touchTargets.drawerSettings.height >= 44);
      await drawer.getByLabel("设置", { exact: true }).tap();
      await page.getByTestId("terminal-settings").waitFor({
        state: "visible",
        timeout: 20_000,
      });
      await page.goBack();
      await page.getByTestId("message-input-root").waitFor({
        state: "visible",
        timeout: 20_000,
      });

      await installFailureAndRetry(page, model, acceptanceFault, context, {
        failedPrompt,
        retriedPrompt,
        dismissedPrompt,
        touchTargets,
        responsiveStages,
        faultInjection,
      });

      const suiteSourceSha256AfterRun = await sha256File(new URL(import.meta.url));
      assert.equal(
        suiteSourceSha256AfterRun,
        suiteSourceSha256AtStart,
        "the responsive suite source must remain unchanged during its run",
      );

      await context.writeArtifactJson("responsive-evidence.json", {
        responsiveSuiteSourceSha256: suiteSourceSha256AtStart,
        viewportWidths: widths,
        responsiveStages,
        touchTargets,
        keyboardState,
        keyboardAudit,
        faultInjection,
        readyStateProbeInstallationAudit,
        fixtureBoundary: {
          freshMobileExport: true,
          mobileSourceTreeSha256: webExport.sourceTreeSha256,
          mobileBuildInputTreeSha256: webExport.buildInputTreeSha256,
          mobileDependencySourceTreeSha256: webExport.dependencySourceTreeSha256,
          mobileDependencyOwnedTreeSha256: webExport.dependencyOwnedTreeSha256,
          mobileBundleSha256: webExport.bundleSha256,
          mobileBundleFileCount: webExport.bundleFileCount,
          mobileIndexHtmlSha256: webExport.indexHtmlSha256,
          mobileBundleManifestPath: webExport.bundleManifestPath,
          terminalBuilderPid: webExport.terminalBuilderPid,
          exporterPid: webExport.exporterPid,
          sourceHashStartedAtUtc: webExport.sourceHashStartedAtUtc,
          sourceHashCompletedAtUtc: webExport.sourceHashCompletedAtUtc,
          sourceHashEndStartedAtUtc: webExport.sourceHashEndStartedAtUtc,
          sourceHashEndCompletedAtUtc: webExport.sourceHashEndCompletedAtUtc,
          exportStartedAtUtc: webExport.exportStartedAtUtc,
          exportCompletedAtUtc: webExport.exportCompletedAtUtc,
          realGateway: true,
          appServerBinaryProvenance: binaryProvenance,
          realAppServerBinarySha256: binarySha256,
          actualAppServerProcessProvenance: actualAppServerProvenance,
          localDeterministicProvider: true,
          fixedReadToolCall: true,
          modelSelectionBehaviorClaimed: false,
          nativeSoftKeyboardAndPhysicalSafeArea: "UNVERIFIED",
        },
        modelFixtureRequests: model.requests.length,
        responsiveSuiteSourceSha256: suiteSourceSha256AtStart,
        responsiveSuiteSourceSha256AfterRun: suiteSourceSha256AfterRun,
        pageErrors,
        consoleErrors,
        rpcMethodCounts: acceptanceFault.methodCounts,
        websocketFaultEvidence: safeAcceptanceFaultEvidence(acceptanceFault),
      });
      assert.deepEqual(pageErrors, []);
      const rootOverflows = responsiveStages.filter(
        (stage) => stage.rootHorizontalOverflow,
      );
      assert.deepEqual(
        rootOverflows.map((stage) => ({
          width: stage.width,
          stage: stage.stage,
          documentWidth: stage.documentWidth,
          bodyWidth: stage.bodyWidth,
        })),
        [],
        "Mobile Web should not widen the document beyond the emulated phone viewport",
      );
      if (keyboardAudit.focusVerdict === "FAIL") {
        assert.equal(
          keyboardState.focused,
          true,
          "the app composer lost focus across viewport resize while the bare textarea control retained focus",
        );
      }
      assert.ok(
        keyboardState.composerBottom <= keyboardState.innerHeight + 1,
        "the composer should remain within the shrunken visual viewport",
      );
      assert.deepEqual(
        Object.entries(touchTargets)
          .filter(([, target]) => !target.centerHitWithinTarget)
          .map(([name]) => name),
        [],
        "audited touch controls must receive a hit at their measured center",
      );
      return {
        widths,
        measuredStages: responsiveStages.length,
        rootHorizontalOverflow: false,
        touchTargetsMeasured: Object.keys(touchTargets).length,
        realGatewayAndAppServer: true,
        deterministicProviderFixture: true,
        nativeKeyboardAndSafeArea: "UNVERIFIED",
        resizeFocusVerdict: keyboardAudit.focusVerdict,
        successScreenshotReason:
          "one responsive transcript, queued composer, and controls view at phone widths",
      };
    } catch (error) {
      await context.writeArtifactJson("responsive-failure.json", {
        message: error instanceof Error ? error.message : String(error),
        responsiveSuiteSourceSha256AtStart: suiteSourceSha256AtStart,
        responsiveSuiteSourceSha256AtFailure: await sha256File(new URL(import.meta.url)).catch(() => null),
        route: new URL(page.url()).pathname,
        responsiveStages,
        touchTargets,
        keyboardState,
        keyboardAudit,
        browserResizeControlAudit,
        faultInjection,
        readyStateProbeInstallationAudit,
        readyStateProbeAtFailure: await readWebSocketReadyStateProbe(page).catch(
          (probeError) => ({
            captureError:
              probeError instanceof Error ? probeError.message : String(probeError),
          }),
        ),
        rpcMethodCounts: acceptanceFault.methodCounts,
        websocketFaultEvidence: safeAcceptanceFaultEvidence(acceptanceFault),
        pageErrors,
        consoleErrors,
        modelFixtureRequestCount: model.requests.length,
        appServerBinaryProvenance: binaryProvenance,
        actualAppServerProcessProvenance: actualAppServerProvenance,
      });
      await page.screenshot({
        path: context.pathInArtifacts("responsive-failure.png"),
      }).catch(() => undefined);
      throw error;
    } finally {
      await page.close().catch(() => undefined);
    }
  },
);

async function installFailureAndRetry(
  page,
  model,
  acceptanceFault,
  context,
  {
    failedPrompt,
    retriedPrompt,
    dismissedPrompt,
    touchTargets,
    responsiveStages,
    faultInjection,
  },
) {
  const createDefinitelyRejectedDraft = async (prompt, label) => {
    faultInjection[label] = {
      kind: "app-server turn/start deserialization rejection before turn registration",
      phase: "sending malformed protocol input",
      syntheticPromptSha256: sha256Text(prompt),
    };
    configureAcceptanceFault(acceptanceFault, "reject-invalid-input", prompt);
    await page.getByTestId("message-input").fill(prompt);
    const requestsBefore = model.requests.length;
    const providerRequestsForPromptBefore = countProviderRequestsForPrompt(
      model.requests,
      prompt,
    );
    await page.getByTestId("send-message").tap();
    const card = page
      .getByTestId("failed-submission")
      .filter({ hasText: prompt })
      .first();
    await card.waitFor({ state: "visible", timeout: 15_000 });
    await page.getByText("发送失败，草稿已保留", { exact: true }).last().waitFor({
      state: "visible",
      timeout: 10_000,
    });
    Object.assign(faultInjection[label], {
      injectedFrames: acceptanceFault.invalidInputRequestCount,
      appServerErrorCode: acceptanceFault.invalidInputResponseCode,
      appServerSerdeRejectionObserved:
        acceptanceFault.invalidInputSerdeRejectionObserved,
      inputTypeSent: "string instead of protocol input array",
      totalProviderRequestCountBefore: requestsBefore,
      totalProviderRequestCountAfterRejection: model.requests.length,
      providerRequestsForPromptBeforeRejection: providerRequestsForPromptBefore,
      outcome: "known failed draft; explicit retry is allowed",
      phase: "known failed card visible",
    });
    assert.equal(
      acceptanceFault.invalidInputRequestCount,
      1,
      "one turn/start request must reach app-server with the deliberately invalid input shape",
    );
    assert.equal(
      acceptanceFault.invalidInputResponseCode,
      -32602,
      "app-server must explicitly reject the malformed turn/start parameters",
    );
    assert.equal(
      acceptanceFault.invalidInputSerdeRejectionObserved,
      true,
      "app-server response must identify the invalid protocol input sequence",
    );
    await page.waitForTimeout(120);
    const providerRequestsForPrompt = countProviderRequestsForPrompt(
      model.requests,
      prompt,
    );
    faultInjection[label].providerRequestsForPromptAfterRejection =
      providerRequestsForPrompt;
    assert.equal(
      providerRequestsForPrompt,
      0,
      "app-server must reject this prompt before any Provider request for that prompt",
    );
    acceptanceFault.mode = "off";
    return { card, requestsBefore };
  };

  const retryCase = await createDefinitelyRejectedDraft(failedPrompt, "retryCase");
  const retryCard = retryCase.card;
  const retry = retryCard.getByTestId("retry-failed-submission");
  const retryDismiss = retryCard.getByTestId("dismiss-failed-submission");
  assert.equal(await retry.isDisabled(), false);
  await retry.scrollIntoViewIfNeeded();
  touchTargets.failedRetry = await targetGeometry(retry);
  touchTargets.failedDismiss = await targetGeometry(retryDismiss);
  assertFailureTouchTargets(touchTargets.failedRetry, touchTargets.failedDismiss);
  for (const width of widths) {
    await setViewport(page, width, 844);
    responsiveStages.push(
      await measureViewport(page, width, "known-failed-submission-card"),
    );
  }
  await setViewport(page, 360, 844);
  await page.screenshot({
    path: context.pathInArtifacts("failed-draft-360.png"),
  });
  await retry.tap();
  await waitFor(
    () => countProviderRequestsForPrompt(model.requests, retriedPrompt) > 0,
    30_000,
    "explicit failed-draft retry to reach the local provider through app-server",
    50,
    context.abortSignal,
  );
  await page.getByText(markdownMarker, { exact: true }).last().waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await retryCard.waitFor({ state: "hidden", timeout: 20_000 });
  assert.ok(
    model.requests.some((request) =>
      JSON.stringify(request.messages ?? []).includes(retriedPrompt),
    ),
    "the explicit retry must reach the isolated local provider",
  );
  faultInjection.retryCase.retryReachedProvider = true;
  faultInjection.retryCase.retryPromptObservedAtProvider = true;
  faultInjection.retryCase.providerRequestsForPromptAfterRetry =
    countProviderRequestsForPrompt(model.requests, retriedPrompt);

  touchTargets.failedRetry.edgeTaps = [];
  for (let index = 0; index < retryEdgePrompts.length; index += 1) {
    const edge = ["top", "bottom", "left", "right"][index];
    const prompt = retryEdgePrompts[index];
    const { card } = await createDefinitelyRejectedDraft(
      prompt,
      `retryEdge${edge[0].toUpperCase()}${edge.slice(1)}`,
    );
    const action = card.getByTestId("retry-failed-submission");
    const geometry = await targetGeometry(action);
    assertFailureRetryGeometry(geometry);
    const touch = await tapTargetEdge(page, action, edge);
    touchTargets.failedRetry.edgeTaps.push({ edge, ...geometry, ...touch });
    await waitFor(
      () => countProviderRequestsForPrompt(model.requests, prompt) === 1,
      30_000,
      `failed-draft retry touch at the ${edge} edge to reach the local Provider exactly once`,
      50,
      context.abortSignal,
    );
    await card.waitFor({ state: "hidden", timeout: 20_000 });
    faultInjection[`retryEdge${edge[0].toUpperCase()}${edge.slice(1)}`].edgeRetryReachedProvider = true;
    faultInjection[`retryEdge${edge[0].toUpperCase()}${edge.slice(1)}`].phase =
      "edge tap retried the known failed draft and removed its card";
  }

  const dismissCase = await createDefinitelyRejectedDraft(
    dismissedPrompt,
    "dismissCase",
  );
  const dismissCard = dismissCase.card;
  const dismissAction = dismissCard.getByTestId("dismiss-failed-submission");
  const retryOnDismissCard = dismissCard.getByTestId("retry-failed-submission");
  assert.equal(await retryOnDismissCard.isDisabled(), false);
  touchTargets.failedDismissAction = await targetGeometry(dismissAction);
  assert.equal(touchTargets.failedDismissAction.width, 44);
  assert.equal(touchTargets.failedDismissAction.height, 44);
  await page.screenshot({
    path: context.pathInArtifacts("failed-draft-dismiss-360.png"),
  });
  touchTargets.failedDismissAction.edgeTaps = [];
  const firstDismissEdgeTouch = await tapTargetEdge(page, dismissAction, "top");
  touchTargets.failedDismissAction.edgeTaps.push({ edge: "top", ...firstDismissEdgeTouch });
  await dismissCard.waitFor({ state: "hidden", timeout: 10_000 });
  faultInjection.dismissCase.dismissActionUsed = true;
  faultInjection.dismissCase.phase = "top edge touch dismissed the known failed draft";

  for (const edge of ["bottom", "left", "right"]) {
    const prompt = dismissEdgePrompts[["top", "bottom", "left", "right"].indexOf(edge)];
    const { card } = await createDefinitelyRejectedDraft(
      prompt,
      `dismissEdge${edge[0].toUpperCase()}${edge.slice(1)}`,
    );
    const action = card.getByTestId("dismiss-failed-submission");
    const geometry = await targetGeometry(action);
    assert.equal(geometry.width, 44);
    assert.equal(geometry.height, 44);
    const touch = await tapTargetEdge(page, action, edge);
    touchTargets.failedDismissAction.edgeTaps.push({ edge, ...geometry, ...touch });
    await card.waitFor({ state: "hidden", timeout: 10_000 });
    faultInjection[`dismissEdge${edge[0].toUpperCase()}${edge.slice(1)}`].edgeDismissUsed = true;
    faultInjection[`dismissEdge${edge[0].toUpperCase()}${edge.slice(1)}`].phase =
      `${edge} edge touch dismissed the known failed draft`;
  }

  await runFreshNotSentRetryCase({
    page,
    model,
    acceptanceFault,
    context,
    touchTargets,
    faultInjection,
  });

  configureAcceptanceFault(
    acceptanceFault,
    "accepted-turn-ack-loss",
    uncertainPrompt,
  );
  faultInjection.acceptedAckLostCase = {
    kind: "server-accepted turn/start; client ACK is corrupted; initial receipt read is forced null",
    phase: "sending accepted turn",
    syntheticPromptSha256: sha256Text(uncertainPrompt),
  };
  await page.getByTestId("message-input").fill(uncertainPrompt);
  const providerRequestsBeforeUncertain = countProviderRequestsForPrompt(
    model.requests,
    uncertainPrompt,
  );
  await page.getByTestId("send-message").tap();
  const uncertainCard = page
    .getByTestId("failed-submission")
    .filter({ hasText: uncertainPrompt })
    .first();
  await uncertainCard.waitFor({ state: "visible", timeout: 15_000 });
  await page.getByText("发送状态待核对", { exact: true }).last().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await waitFor(
    () => countProviderRequestsForPrompt(model.requests, uncertainPrompt) === 1,
    30_000,
    "the server-accepted uncertain turn to reach the local Provider exactly once",
    50,
    context.abortSignal,
  );
  await waitFor(
    () =>
      acceptanceFault.acceptanceResponseCorrupted &&
      acceptanceFault.receiptReadRequestCount === 1 &&
      acceptanceFault.firstReceiptNullResponseInjected,
    10_000,
    "the accepted turn ACK to be lost and the first receipt read to remain inconclusive",
    50,
    context.abortSignal,
  );
  Object.assign(faultInjection.acceptedAckLostCase, {
    phase: "accepted, ACK corrupted, and initial receipt read returned null",
    acceptedTurnStartRequests: acceptanceFault.acceptedTurnStartRequestCount,
    corruptedTurnStartResponses: acceptanceFault.corruptedTurnStartResponseCount,
    acceptedTurnResponseObserved: acceptanceFault.acceptedTurnResponseObserved,
    acceptedTurnResponseThreadMatchesRequest:
      acceptanceFault.acceptedTurnResponseThreadMatchesRequest,
    acceptedTurnStatus: acceptanceFault.acceptedTurnStatus,
    acceptedThreadIdSha256: acceptanceFault.acceptedThreadId
      ? sha256Text(acceptanceFault.acceptedThreadId)
      : null,
    acceptedTurnIdSha256: acceptanceFault.acceptedTurnId
      ? sha256Text(acceptanceFault.acceptedTurnId)
      : null,
    clientMessageIdSha256: acceptanceFault.targetClientMessageId
      ? sha256Text(acceptanceFault.targetClientMessageId)
      : null,
    firstReceiptNullResponseInjected:
      acceptanceFault.firstReceiptNullResponseInjected,
    receiptReadRequests: acceptanceFault.receiptReadRequestCount,
  });
  assert.equal(acceptanceFault.acceptedTurnStartRequestCount, 1);
  assert.equal(acceptanceFault.corruptedTurnStartResponseCount, 1);
  assert.equal(acceptanceFault.acceptedTurnResponseObserved, true);
  assert.equal(acceptanceFault.acceptedTurnResponseThreadMatchesRequest, true);
  assert.ok(acceptanceFault.acceptedThreadId);
  assert.ok(acceptanceFault.acceptedTurnId);
  assert.ok(
    ["running", "completed", "failed", "interrupted"].includes(
      acceptanceFault.acceptedTurnStatus,
    ),
  );
  const verify = uncertainCard.getByTestId("verify-failed-submission");
  assert.equal(await verify.isDisabled(), false);
  assert.equal(await uncertainCard.getByTestId("retry-failed-submission").count(), 0);
  touchTargets.uncertainVerify = await targetGeometry(verify);
  assertFailureRetryGeometry(touchTargets.uncertainVerify);
  await page.screenshot({
    path: context.pathInArtifacts("uncertain-delivery-before-receipt-check-360.png"),
  });
  const receiptReadsBeforeVerify = acceptanceFault.receiptReadRequestCount;
  const receiptResponsesBeforeVerify = acceptanceFault.receiptReadResponseCount;
  await verify.tap();
  await waitFor(
    () => acceptanceFault.receiptReadRequestCount > receiptReadsBeforeVerify,
    10_000,
    "the explicit unknown-delivery action to query the app-server receipt",
    50,
    context.abortSignal,
  );
  await waitFor(
    () => acceptanceFault.receiptReadResponseCount > receiptResponsesBeforeVerify,
    10_000,
    "the explicit receipt check to receive authoritative app-server state",
    50,
    context.abortSignal,
  );
  await uncertainCard.waitFor({
    state: "hidden",
    timeout: 20_000,
  });
  await waitFor(
    () => acceptanceFault.receiptReadResponseCount === acceptanceFault.receiptReadRequestCount,
    10_000,
    "all stable-identity receipt reads to finish before evidence is recorded",
    50,
    context.abortSignal,
  );
  assert.ok(acceptanceFault.receiptReadRequestCount >= 2);
  assert.equal(
    acceptanceFault.receiptReadResponseCount,
    acceptanceFault.receiptReadRequestCount,
  );
  assert.equal(acceptanceFault.lastReceiptFound, true);
  assert.equal(acceptanceFault.lastReceiptMatchesSubmittedThread, true);
  assert.equal(acceptanceFault.lastReceiptMatchesAcceptedTurn, true);
  assert.ok(
    ["running", "completed", "failed", "interrupted"].includes(
      acceptanceFault.lastReceiptStatus,
    ),
    "the explicit receipt query must recover the exact accepted turn status",
  );
  assert.equal(acceptanceFault.acceptedTurnStartRequestCount, 1);
  assert.equal(
    countProviderRequestsForPrompt(model.requests, uncertainPrompt),
    1,
    "receipt recovery must not replay the already accepted turn or call the Provider twice",
  );
  const acceptedUserNavigation = await waitForUserMessageAtTranscriptLatest({
    page,
    prompt: uncertainPrompt,
    context,
    evidence: faultInjection.acceptedAckLostCase,
    evidenceKey: "userMessageNavigation",
    waitDescription:
      "accepted turn user message to be mounted and visible after receipt recovery",
  });
  Object.assign(faultInjection.acceptedAckLostCase, {
    phase: "authoritative receipt recovered; unknown card removed",
    acceptedTurnStartRequests: acceptanceFault.acceptedTurnStartRequestCount,
    corruptedTurnStartResponses: acceptanceFault.corruptedTurnStartResponseCount,
    acceptedTurnResponseObserved: acceptanceFault.acceptedTurnResponseObserved,
    acceptedTurnResponseThreadMatchesRequest:
      acceptanceFault.acceptedTurnResponseThreadMatchesRequest,
    acceptedTurnStatus: acceptanceFault.acceptedTurnStatus,
    acceptedThreadIdSha256: acceptanceFault.acceptedThreadId
      ? sha256Text(acceptanceFault.acceptedThreadId)
      : null,
    acceptedTurnIdSha256: acceptanceFault.acceptedTurnId
      ? sha256Text(acceptanceFault.acceptedTurnId)
      : null,
    clientMessageIdSha256: acceptanceFault.targetClientMessageId
      ? sha256Text(acceptanceFault.targetClientMessageId)
      : null,
    firstReceiptNullResponseInjected:
      acceptanceFault.firstReceiptNullResponseInjected,
    receiptReadRequestsForStableClientMessageId: acceptanceFault.receiptReadRequestCount,
    receiptReadResponsesForStableClientMessageId: acceptanceFault.receiptReadResponseCount,
    authoritativeReceiptRecovered: acceptanceFault.lastReceiptFound,
    authoritativeReceiptStatus: acceptanceFault.lastReceiptStatus,
    receiptMatchesSubmittedThread: acceptanceFault.lastReceiptMatchesSubmittedThread,
    receiptMatchesAcceptedTurn: acceptanceFault.lastReceiptMatchesAcceptedTurn,
    receiptThreadIdSha256: acceptanceFault.lastReceiptThreadId
      ? sha256Text(acceptanceFault.lastReceiptThreadId)
      : null,
    receiptTurnIdSha256: acceptanceFault.lastReceiptTurnId
      ? sha256Text(acceptanceFault.lastReceiptTurnId)
      : null,
    providerRequestsForPromptBefore: providerRequestsBeforeUncertain,
    providerRequestsForPromptAfterRecovery: countProviderRequestsForPrompt(
      model.requests,
      uncertainPrompt,
    ),
    visibleUserMessageCount:
      acceptedUserNavigation.after.userMessageCount,
    userMessageVisibleInTranscript:
      acceptedUserNavigation.after.visibility.intersectsMessageList,
    userMessageNavigation: acceptedUserNavigation,
    retryActionExposedWhileUnknown: false,
    receiptActionClearedUnknownCard: true,
  });
  await page.screenshot({
    path: context.pathInArtifacts("uncertain-delivery-after-receipt-check-360.png"),
  });
  acceptanceFault.mode = "off";
}

async function runFreshNotSentRetryCase({
  page,
  model,
  acceptanceFault,
  context,
  touchTargets,
  faultInjection,
}) {
  const prompt = freshNotSentPrompt;
  configureAcceptanceFault(acceptanceFault, "capture-fresh-not-sent-retry", prompt);
  faultInjection.freshNotSentRetryCase = {
    kind: "client readyState preflight reports CLOSED while the same captured browser-facing runtime WebSocket object remains unforced OPEN",
    phase: "before fresh submission",
    syntheticPromptSha256: sha256Text(prompt),
  };
  const probeBeforeForce = await readWebSocketReadyStateProbe(page);
  Object.assign(faultInjection.freshNotSentRetryCase, {
    probeBeforeForce,
  });
  assert.equal(probeBeforeForce.windowConstructorMatchesWrapper, true);
  assert.ok(probeBeforeForce.runtimeSocketCount > 0);
  assert.ok(
    probeBeforeForce.unforcedReadyStates.includes(1),
    "the captured browser-facing runtime WebSocket object must remain unforced OPEN before the test forces its effective state",
  );
  const startFramesBefore = acceptanceFault.methodCounts["turn/start"] ?? 0;
  const receiptReadsBefore = acceptanceFault.methodCounts["turn/receipt/read"] ?? 0;
  const providerRequestsBefore = countProviderRequestsForPrompt(model.requests, prompt);
  await page.getByTestId("message-input").fill(prompt);
  await configureWebSocketReadyStateProbe(page, {
    targetPrompt: prompt,
    forceClosed: true,
    resetTargetSendCount: true,
  });
  const probeBeforeTap = await readWebSocketReadyStateProbe(page);
  Object.assign(faultInjection.freshNotSentRetryCase, {
    probeBeforeTap,
  });
  assert.equal(probeBeforeTap.windowConstructorMatchesWrapper, true);
  assert.ok(probeBeforeTap.unforcedReadyStates.includes(1));
  assert.ok(
    probeBeforeTap.sockets.some(
      (socket) =>
        socket.unforcedReadyState === 1 && socket.effectiveReadyState === 3,
    ),
    "the probe must force CLOSED on the same captured runtime socket that remains unforced OPEN",
  );
  const appForcedReadsBeforeTap =
    probeBeforeTap.applicationForcedClosedReadyStateReads;
  await page.getByTestId("send-message").tap();
  await waitFor(
    async () => {
      const probe = await readWebSocketReadyStateProbe(page);
      return (
        probe.applicationForcedClosedReadyStateReads > appForcedReadsBeforeTap ||
        probe.targetTurnStartSendInvocations > 0 ||
        (acceptanceFault.methodCounts["turn/start"] ?? 0) > startFramesBefore
      );
    },
    5_000,
    "the forced readyState read or a prompt-matched turn/start send attempt to be observed",
    25,
    context.abortSignal,
  );
  const probeAfterSubmit = await readWebSocketReadyStateProbe(page);
  const turnStartFramesAfterSubmit =
    acceptanceFault.methodCounts["turn/start"] ?? 0;
  const receiptReadsAfterSubmit =
    acceptanceFault.methodCounts["turn/receipt/read"] ?? 0;
  const providerRequestsAfterSubmit = countProviderRequestsForPrompt(
    model.requests,
    prompt,
  );
  Object.assign(faultInjection.freshNotSentRetryCase, {
    phase: "preflight probe observed after submit touch",
    probeAfterSubmit,
    gatewayTurnStartFrameCountDelta:
      turnStartFramesAfterSubmit - startFramesBefore,
    receiptReadCountDelta: receiptReadsAfterSubmit - receiptReadsBefore,
    providerRequestsForPrompt: providerRequestsAfterSubmit,
  });
  assert.ok(
    probeAfterSubmit.applicationForcedClosedReadyStateReads >
      appForcedReadsBeforeTap,
    "the app must read the forced CLOSED state during the submit interaction; diagnostic sampling is counted separately",
  );
  assert.equal(
    probeAfterSubmit.targetTurnStartSendInvocations,
    0,
    "the same captured runtime socket must not send the fresh turn/start after its effective state is forced CLOSED",
  );
  assert.equal(
    turnStartFramesAfterSubmit,
    startFramesBefore,
    "no prompt-matched turn/start frame may reach the Gateway during a proven notSent preflight",
  );
  assert.equal(
    receiptReadsAfterSubmit,
    receiptReadsBefore,
    "a fresh notSent clientMessageId must not trigger a receipt lookup",
  );
  assert.equal(
    providerRequestsAfterSubmit,
    providerRequestsBefore,
    "a fresh notSent preflight must not reach the Provider",
  );
  const card = page
    .getByTestId("failed-submission")
    .filter({ hasText: prompt })
    .first();
  await card.waitFor({ state: "visible", timeout: 15_000 });
  await card.scrollIntoViewIfNeeded();
  const failedCardSnapshot = await card.evaluate((element) => {
    const titleOptions = [
      "发送失败，草稿已保留",
      "发送状态待核对",
      "正在发送，恢复记录已保存",
    ];
    const title = Array.from(element.querySelectorAll("*"))
      .map((node) => node.textContent?.trim() ?? "")
      .find((text) => titleOptions.includes(text)) ?? null;
    const rect = element.getBoundingClientRect();
    const list = document.querySelector('[data-testid="message-list"]');
    const listRect = list?.getBoundingClientRect();
    return {
      title,
      actionTestIds: Array.from(element.querySelectorAll("[data-testid]"))
        .map((node) => node.getAttribute("data-testid"))
        .filter(Boolean),
      bounds: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      intersectsMessageList: Boolean(
        listRect &&
        rect.right > listRect.left &&
        rect.left < listRect.right &&
        rect.bottom > listRect.top &&
        rect.top < listRect.bottom,
      ),
    };
  });
  faultInjection.freshNotSentRetryCase.failedCardSnapshot = failedCardSnapshot;
  await page.screenshot({
    path: context.pathInArtifacts("fresh-not-sent-card-360.png"),
  });
  await page.getByText("发送失败，草稿已保留", { exact: true }).last().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const clientMessageId = await waitForPersistedFailedSubmissionId(page, prompt);
  assert.match(clientMessageId, /^composer-/);
  const preRetryProbe = await readWebSocketReadyStateProbe(page);
  const turnStartFramesAfter = acceptanceFault.methodCounts["turn/start"] ?? 0;
  const receiptReadsAfter = acceptanceFault.methodCounts["turn/receipt/read"] ?? 0;
  const providerRequestsAfter = countProviderRequestsForPrompt(model.requests, prompt);
  Object.assign(faultInjection.freshNotSentRetryCase, {
    phase: "retryable failure card visible; preflight evidence captured",
    failedCardSnapshot,
    retryableFailureCardVisible: await card.isVisible(),
    preRetry: {
      runtimeSocketCount: preRetryProbe.runtimeSocketCount,
      unforcedReadyStates: preRetryProbe.unforcedReadyStates,
      unforcedStateSources: preRetryProbe.sockets.map(
        (socket) => socket.unforcedStateSource,
      ),
      effectiveReadyStates: preRetryProbe.effectiveReadyStates,
      applicationForcedClosedReadyStateReads:
        preRetryProbe.applicationForcedClosedReadyStateReads,
      turnStartSendMethodCalls: preRetryProbe.targetTurnStartSendInvocations,
      gatewayTurnStartFrameCountDelta: turnStartFramesAfter - startFramesBefore,
      receiptReadCountDelta: receiptReadsAfter - receiptReadsBefore,
      providerRequestsForPrompt: providerRequestsAfter,
    },
  });
  assert.ok(preRetryProbe.runtimeSocketCount > 0);
  assert.ok(preRetryProbe.unforcedReadyStates.includes(1), "the captured browser-facing runtime WebSocket object should still be unforced OPEN");
  assert.ok(preRetryProbe.effectiveReadyStates.includes(3), "the controlled preflight must observe readyState=CLOSED");
  assert.ok(
    preRetryProbe.applicationForcedClosedReadyStateReads > 0,
    "the app must query the forced CLOSED readyState; diagnostic sampling is counted separately",
  );
  assert.equal(preRetryProbe.targetTurnStartSendInvocations, 0, "the client must not call WebSocket.send for turn/start during notSent preflight");
  assert.equal(turnStartFramesAfter, startFramesBefore, "no turn/start frame may reach the Gateway during notSent preflight");
  assert.equal(receiptReadsAfter, receiptReadsBefore, "a fresh notSent clientMessageId must not trigger a receipt lookup");
  assert.equal(providerRequestsAfter, providerRequestsBefore, "notSent preflight must not reach the Provider");

  const retry = card.getByTestId("retry-failed-submission");
  assert.equal(await retry.isVisible(), true, "a proven notSent fresh submission must expose a retry action");
  assert.equal(await retry.isDisabled(), false);
  assert.equal(await card.getByTestId("verify-failed-submission").count(), 0);
  touchTargets.freshNotSentRetry = await targetGeometry(retry);
  assertFailureRetryGeometry(touchTargets.freshNotSentRetry);
  await page.screenshot({
    path: context.pathInArtifacts("fresh-not-sent-retry-before-360.png"),
  });

  await configureWebSocketReadyStateProbe(page, { forceClosed: false });
  faultInjection.freshNotSentRetryCase.phase = "user retry touch issued";
  const retryStartFramesBefore = acceptanceFault.methodCounts["turn/start"] ?? 0;
  await retry.tap();
  await waitFor(
    () => countProviderRequestsForPrompt(model.requests, prompt) === 1,
    30_000,
    "manual retry of the fresh notSent draft to reach the local Provider exactly once",
    50,
    context.abortSignal,
  );
  await card.waitFor({ state: "hidden", timeout: 20_000 });
  const retryStartFramesAfter = acceptanceFault.methodCounts["turn/start"] ?? 0;
  const retryClientMessageId = acceptanceFault.retryClientMessageId;
  assert.equal(acceptanceFault.freshNotSentRetryTurnStartFrameCount, 1);
  assert.equal(retryStartFramesAfter - retryStartFramesBefore, 1);
  assert.equal(retryClientMessageId, clientMessageId, "retry must reuse the exact stable clientMessageId from the fresh failed draft");
  assert.equal(countProviderRequestsForPrompt(model.requests, prompt), 1);
  Object.assign(faultInjection.freshNotSentRetryCase, {
    phase: "retry reached provider; checking virtualized transcript after explicit latest navigation",
    retry: {
      turnStartFrameCount: acceptanceFault.freshNotSentRetryTurnStartFrameCount,
      clientMessageIdStable: retryClientMessageId === clientMessageId,
      providerRequestsForPrompt: countProviderRequestsForPrompt(
        model.requests,
        prompt,
      ),
    },
  });
  const retryUserNavigation = await waitForUserMessageAtTranscriptLatest({
    page,
    prompt,
    context,
    evidence: faultInjection.freshNotSentRetryCase,
    evidenceKey: "userMessageNavigation",
    waitDescription:
      "retried user message to be mounted and visible after explicit latest navigation",
  });
  Object.assign(faultInjection.freshNotSentRetryCase, {
    phase: "retry accepted by app-server and Provider exactly once; one user message visible at latest position",
    retry: {
      turnStartFrameCount: acceptanceFault.freshNotSentRetryTurnStartFrameCount,
      clientMessageIdStable: retryClientMessageId === clientMessageId,
      failedDraftClientMessageIdSha256: sha256Text(clientMessageId),
      retryClientMessageIdSha256: sha256Text(retryClientMessageId),
      providerRequestsForPrompt: countProviderRequestsForPrompt(model.requests, prompt),
      visibleUserMessageCount: retryUserNavigation.after.userMessageCount,
      visibleInTranscriptList:
        retryUserNavigation.after.visibility.intersectsMessageList,
      transcriptVisibility: retryUserNavigation.after.visibility,
      userMessageNavigation: retryUserNavigation,
    },
  });
  await page.screenshot({
    path: context.pathInArtifacts("fresh-not-sent-retry-message-visible-360.png"),
  });
  acceptanceFault.mode = "off";
}

async function waitForUserMessageAtTranscriptLatest({
  page,
  prompt,
  context,
  evidence,
  evidenceKey,
  waitDescription,
}) {
  const userMessage = page
    .getByTestId("message-user")
    .filter({ hasText: prompt });
  const jumpToLatest = page.getByTestId("jump-to-latest");
  const jumpToLatestVisibleBefore = await jumpToLatest.isVisible();
  const userMessageCountBefore = await userMessage.count();
  const userMessageVisibleBefore =
    userMessageCountBefore === 1 && (await userMessage.isVisible());
  const navigation = {
    jumpToLatestVisibleBefore,
    jumpToLatestTapped: false,
    before: {
      userMessageCount: userMessageCountBefore,
      userMessageVisible: userMessageVisibleBefore,
      visibility:
        userMessageCountBefore === 1
          ? await transcriptVisibility(userMessage)
          : null,
    },
    after: null,
  };
  evidence[evidenceKey] = navigation;

  if (jumpToLatestVisibleBefore) {
    await jumpToLatest.tap();
    navigation.jumpToLatestTapped = true;
  }
  await waitFor(
    async () => {
      if ((await userMessage.count()) !== 1) return false;
      if (!(await userMessage.isVisible())) return false;
      return (await transcriptVisibility(userMessage)).intersectsMessageList;
    },
    10_000,
    waitDescription,
    50,
    context.abortSignal,
  );

  const userMessageCount = await userMessage.count();
  navigation.after = {
    userMessageCount,
    userMessageVisible: await userMessage.isVisible(),
    visibility: await transcriptVisibility(userMessage),
  };
  assert.equal(
    userMessageCount,
    1,
    "the transcript must contain exactly one user message at the visible latest position",
  );
  assert.ok(
    navigation.after.visibility.intersectsMessageList,
    "the target user message must intersect the visible transcript list after bounded UI navigation",
  );
  return navigation;
}

async function waitForPersistedFailedSubmissionId(page, prompt) {
  let id = null;
  await waitFor(
    async () => {
      id = await page.evaluate((targetPrompt) => {
        const prefix = "kcoder-studio:mobile-workspace-state:v3:";
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          try {
            const state = JSON.parse(localStorage.getItem(key) ?? "null");
            const item = state?.failedSubmissions?.find(
              (entry) => entry?.content === targetPrompt && typeof entry.id === "string",
            );
            if (item) return item.id;
          } catch {
            // Ignore unrelated malformed state values; only return the synthetic target item.
          }
        }
        return null;
      }, prompt);
      return typeof id === "string";
    },
    10_000,
    "the synthetic failed-submission identity to persist in its workspace-state key",
    50,
  );
  return id;
}

function countProviderRequestsForPrompt(requests, prompt) {
  return requests.filter((request) =>
    JSON.stringify(request.messages ?? []).includes(prompt),
  ).length;
}

function createAcceptanceFaultState() {
  return {
    mode: "off",
    targetPrompt: null,
    targetClientMessageId: null,
    invalidInputRequestCount: 0,
    invalidInputResponseCode: null,
    invalidInputSerdeRejectionObserved: false,
    acceptedTurnStartRequestCount: 0,
    corruptedTurnStartResponseCount: 0,
    acceptedTurnResponseObserved: false,
    acceptedTurnResponseThreadMatchesRequest: false,
    acceptedTurnStatus: null,
    acceptedThreadId: null,
    acceptedTurnId: null,
    acceptanceResponseCorrupted: false,
    receiptReadRequestCount: 0,
    receiptReadResponseCount: 0,
    firstReceiptNullResponseInjected: false,
    lastReceiptFound: false,
    lastReceiptStatus: null,
    lastReceiptMatchesSubmittedThread: false,
    lastReceiptMatchesAcceptedTurn: false,
    lastReceiptThreadId: null,
    lastReceiptTurnId: null,
    freshNotSentRetryTurnStartFrameCount: 0,
    retryClientMessageId: null,
    methodCounts: {},
  };
}

function configureAcceptanceFault(state, mode, prompt) {
  state.mode = mode;
  state.targetPrompt = prompt;
  state.targetClientMessageId = null;
  state.invalidInputRequestCount = 0;
  state.invalidInputResponseCode = null;
  state.invalidInputSerdeRejectionObserved = false;
  state.acceptedTurnStartRequestCount = 0;
  state.corruptedTurnStartResponseCount = 0;
  state.acceptedTurnResponseObserved = false;
  state.acceptedTurnResponseThreadMatchesRequest = false;
  state.acceptedTurnStatus = null;
  state.acceptedThreadId = null;
  state.acceptedTurnId = null;
  state.acceptanceResponseCorrupted = false;
  state.receiptReadRequestCount = 0;
  state.receiptReadResponseCount = 0;
  state.firstReceiptNullResponseInjected = false;
  state.lastReceiptFound = false;
  state.lastReceiptStatus = null;
  state.lastReceiptMatchesSubmittedThread = false;
  state.lastReceiptMatchesAcceptedTurn = false;
  state.lastReceiptThreadId = null;
  state.lastReceiptTurnId = null;
  state.freshNotSentRetryTurnStartFrameCount = 0;
  state.retryClientMessageId = null;
}

function safeAcceptanceFaultEvidence(state) {
  return {
    mode: state.mode,
    invalidInputRequestCount: state.invalidInputRequestCount,
    invalidInputResponseCode: state.invalidInputResponseCode,
    invalidInputSerdeRejectionObserved:
      state.invalidInputSerdeRejectionObserved,
    acceptedTurnStartRequestCount: state.acceptedTurnStartRequestCount,
    corruptedTurnStartResponseCount: state.corruptedTurnStartResponseCount,
    acceptedTurnResponseObserved: state.acceptedTurnResponseObserved,
    acceptedTurnResponseThreadMatchesRequest:
      state.acceptedTurnResponseThreadMatchesRequest,
    acceptedTurnStatus: state.acceptedTurnStatus,
    acceptedThreadIdSha256: state.acceptedThreadId
      ? sha256Text(state.acceptedThreadId)
      : null,
    acceptedTurnIdSha256: state.acceptedTurnId
      ? sha256Text(state.acceptedTurnId)
      : null,
    acceptanceResponseCorrupted: state.acceptanceResponseCorrupted,
    receiptReadRequestCount: state.receiptReadRequestCount,
    receiptReadResponseCount: state.receiptReadResponseCount,
    firstReceiptNullResponseInjected: state.firstReceiptNullResponseInjected,
    lastReceiptFound: state.lastReceiptFound,
    lastReceiptStatus: state.lastReceiptStatus,
    lastReceiptMatchesSubmittedThread: state.lastReceiptMatchesSubmittedThread,
    lastReceiptMatchesAcceptedTurn: state.lastReceiptMatchesAcceptedTurn,
    lastReceiptThreadIdSha256: state.lastReceiptThreadId
      ? sha256Text(state.lastReceiptThreadId)
      : null,
    lastReceiptTurnIdSha256: state.lastReceiptTurnId
      ? sha256Text(state.lastReceiptTurnId)
      : null,
    acceptedClientMessageIdSha256: state.targetClientMessageId
      ? sha256Text(state.targetClientMessageId)
      : null,
    freshNotSentRetryTurnStartFrameCount:
      state.freshNotSentRetryTurnStartFrameCount,
    retryClientMessageIdSha256: state.retryClientMessageId
      ? sha256Text(state.retryClientMessageId)
      : null,
    methodCounts: { ...state.methodCounts },
  };
}

function installResponsiveWebSocketFaultRoute(page, state) {
  page.routeWebSocket("**/rpc*", (socket) => {
    const upstream = socket.connectToServer();
    const requests = new Map();
    socket.onMessage((raw) => {
      let outgoing = raw;
      try {
        const message = JSON.parse(String(raw));
        if (
          message.id !== undefined &&
          typeof message.method === "string"
        ) {
          state.methodCounts[message.method] =
            (state.methodCounts[message.method] ?? 0) + 1;
          const meta = { method: message.method };
          if (message.method === "turn/start") {
            const input = JSON.stringify(message.params?.input ?? []);
            const matchesTarget =
              typeof state.targetPrompt === "string" &&
              input.includes(state.targetPrompt);
            if (matchesTarget && state.mode === "reject-invalid-input") {
              message.params.input = "KCODER_E2E_INVALID_TURN_INPUT_SHAPE";
              state.invalidInputRequestCount += 1;
              meta.rejectInvalidInput = true;
              outgoing = JSON.stringify(message);
            } else if (
              matchesTarget &&
              state.mode === "accepted-turn-ack-loss"
            ) {
              state.acceptedTurnStartRequestCount += 1;
              state.targetClientMessageId =
                typeof message.params?.clientMessageId === "string"
                  ? message.params.clientMessageId
                  : null;
              state.acceptedThreadId =
                typeof message.params?.threadId === "string"
                  ? message.params.threadId
                  : null;
              meta.acceptedTurnWithLostAck = true;
            } else if (
              matchesTarget &&
              state.mode === "capture-fresh-not-sent-retry"
            ) {
              state.freshNotSentRetryTurnStartFrameCount += 1;
              state.retryClientMessageId =
                typeof message.params?.clientMessageId === "string"
                  ? message.params.clientMessageId
                  : null;
            }
          } else if (
            message.method === "turn/receipt/read" &&
            state.mode === "accepted-turn-ack-loss" &&
            typeof state.targetClientMessageId === "string" &&
            message.params?.clientMessageId === state.targetClientMessageId
          ) {
            meta.targetReceiptRead = true;
            state.receiptReadRequestCount += 1;
          }
          requests.set(message.id, meta);
        }
      } catch {
        // Pass through non-JSON frames without retaining their contents.
      }
      upstream.send(outgoing);
    });
    upstream.onMessage((raw) => {
      let outgoing = raw;
      try {
        const message = JSON.parse(String(raw));
        const meta =
          message.id !== undefined ? requests.get(message.id) : undefined;
        if (meta?.rejectInvalidInput && message.error) {
          state.invalidInputResponseCode = message.error.code ?? null;
          state.invalidInputSerdeRejectionObserved =
            typeof message.error.message === "string" &&
            message.error.message.includes("invalid type: string") &&
            message.error.message.includes("expected a sequence");
        }
        if (meta?.acceptedTurnWithLostAck && message.result) {
          const turn = message.result?.turn;
          const validStatus = ["running", "completed", "failed", "interrupted"]
            .includes(turn?.status);
          const validTurn =
            typeof turn?.id === "string" && turn.id.trim().length > 0 &&
            typeof turn?.threadId === "string" &&
            typeof state.acceptedThreadId === "string" &&
            turn.threadId === state.acceptedThreadId &&
            validStatus;
          state.acceptedTurnResponseThreadMatchesRequest =
            typeof turn?.threadId === "string" &&
            typeof state.acceptedThreadId === "string" &&
            turn.threadId === state.acceptedThreadId;
          if (validTurn) {
            state.acceptedTurnResponseObserved = true;
            state.acceptedTurnStatus = turn.status;
            state.acceptedTurnId = turn.id;
            state.corruptedTurnStartResponseCount += 1;
            state.acceptanceResponseCorrupted = true;
            outgoing = JSON.stringify({ ...message, result: {} });
          }
        } else if (meta?.targetReceiptRead && message.result) {
          state.receiptReadResponseCount += 1;
          if (
            state.receiptReadResponseCount === 1 &&
            !state.firstReceiptNullResponseInjected
          ) {
            state.firstReceiptNullResponseInjected = true;
            outgoing = JSON.stringify({
              ...message,
              result: { receipt: null },
            });
          } else {
            const receipt = message.result.receipt;
            state.lastReceiptFound = Boolean(receipt);
            state.lastReceiptStatus =
              typeof receipt?.status === "string" ? receipt.status : null;
            state.lastReceiptMatchesSubmittedThread =
              typeof state.acceptedThreadId === "string" &&
              receipt?.threadId === state.acceptedThreadId;
            state.lastReceiptMatchesAcceptedTurn =
              typeof state.acceptedTurnId === "string" &&
              receipt?.turnId === state.acceptedTurnId;
            state.lastReceiptThreadId =
              typeof receipt?.threadId === "string" ? receipt.threadId : null;
            state.lastReceiptTurnId =
              typeof receipt?.turnId === "string" ? receipt.turnId : null;
          }
        }
        if (message.id !== undefined) requests.delete(message.id);
      } catch {
        // Pass through non-JSON frames without retaining their contents.
      }
      socket.send(outgoing);
    });
  });
}

async function setViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    (expected) => window.innerWidth === expected,
    width,
    { timeout: 5_000 },
  );
  await page.waitForTimeout(80);
}

async function runViewportResizeControl(page) {
  await page.setContent([
    "<!doctype html>",
    "<html><head>",
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    "<style>html,body{margin:0;width:100%;height:100%;}textarea{box-sizing:border-box;width:100%;height:48px;}</style>",
    '</head><body><textarea id="resize-control-input" aria-label="resize control"></textarea></body></html>',
  ].join(""));
  const selector = "#resize-control-input";
  const expectedDraft = "bare resize control draft";
  await installInputFocusProbe(page, selector);
  const input = page.locator(selector);
  await input.tap();
  await input.fill(expectedDraft);
  const beforeResize = await readInputFocusProbe(page, selector, expectedDraft);
  await page.setViewportSize({ width: 360, height: 500 });
  await page.waitForFunction(
    () => window.innerWidth === 360 && window.innerHeight === 500,
    undefined,
    { timeout: 5_000 },
  );
  const afterResizeImmediate = await readInputFocusProbe(
    page,
    selector,
    expectedDraft,
  );
  await waitForResizeStability(page);
  const afterResizeStable = await readInputFocusProbe(
    page,
    selector,
    expectedDraft,
  );
  return {
    viewport: { width: 360, height: 844 },
    resizedViewport: { width: 360, height: 500 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    scope: "bare local textarea; no app, network, or native OS keyboard",
    beforeResize,
    afterResizeImmediate,
    afterResizeStable,
  };
}

async function installInputFocusProbe(page, selector) {
  await page.evaluate((inputSelector) => {
    const input = document.querySelector(inputSelector);
    if (!input) throw new Error("focus probe target not found: " + inputSelector);
    const events = [];
    const state = { originalNode: input, events };
    const describe = (element) => ({
      tagName: element?.tagName ?? null,
      testId: element?.getAttribute?.("data-testid") ?? null,
      id: element?.id || null,
    });
    const record = (type, target) => {
      const current = document.querySelector(inputSelector);
      if (target !== state.originalNode && target !== current) return;
      events.push({
        type,
        targetIsOriginalNode: target === state.originalNode,
        target: describe(target),
        targetConnected: Boolean(target?.isConnected),
        activeElement: describe(document.activeElement),
      });
    };
    for (const type of ["focus", "blur", "focusin", "focusout"]) {
      document.addEventListener(type, (event) => record(type, event.target), true);
    }
    window.addEventListener("resize", () =>
      record("window-resize", document.querySelector(inputSelector)),
      true,
    );
    window.visualViewport?.addEventListener("resize", () =>
      record("visual-viewport-resize", document.querySelector(inputSelector)),
    );
    window.__mobileResponsiveFocusProbe = state;
  }, selector);
}

async function readInputFocusProbe(page, selector, expectedDraft) {
  return page.evaluate(({ inputSelector, expected }) => {
    const state = window.__mobileResponsiveFocusProbe;
    const input = document.querySelector(inputSelector);
    if (!state) throw new Error("focus probe was not installed");
    const describe = (element) => ({
      tagName: element?.tagName ?? null,
      testId: element?.getAttribute?.("data-testid") ?? null,
      id: element?.id || null,
    });
    const composerRoot = document.querySelector('[data-testid="message-input-root"]');
    return {
      targetFound: Boolean(input),
      target: describe(input),
      focused: Boolean(input && document.activeElement === input),
      sameNodeAsBeforeResize: Boolean(input && input === state.originalNode),
      originalNodeConnected: Boolean(state.originalNode?.isConnected),
      currentNodeConnected: Boolean(input?.isConnected),
      disabled: input ? Boolean(input.disabled) : null,
      readOnly: input ? Boolean(input.readOnly) : null,
      valueMatchesExpected: input ? input.value === expected : false,
      activeElement: describe(document.activeElement),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualViewportWidth: window.visualViewport?.width ?? null,
      visualViewportHeight: window.visualViewport?.height ?? null,
      composerBottom: composerRoot?.getBoundingClientRect().bottom ?? null,
      events: [...state.events],
    };
  }, { inputSelector: selector, expected: expectedDraft });
}

async function waitForResizeStability(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
  }));
}

function resizeFocusVerdict(app, control) {
  if (!app.beforeResize?.focused || !app.afterResizeStable) return "UNVERIFIED";
  if (app.afterResizeStable.focused) return "PASS";
  if (control.beforeResize?.focused && control.afterResizeStable?.focused) {
    return "FAIL";
  }
  return "UNVERIFIED";
}

async function transcriptVisibility(locator) {
  return locator.evaluate((element) => {
    const round = (value) => Math.round(value * 10) / 10;
    const rect = element.getBoundingClientRect();
    const list = document.querySelector('[data-testid="message-list"]');
    if (!list) throw new Error("the visible transcript scroll container is missing");
    const listRect = list.getBoundingClientRect();
    const left = Math.max(rect.left, listRect.left, 0);
    const right = Math.min(rect.right, listRect.right, window.innerWidth);
    const top = Math.max(rect.top, listRect.top, 0);
    const bottom = Math.min(rect.bottom, listRect.bottom, window.innerHeight);
    return {
      elementRect: {
        left: round(rect.left),
        right: round(rect.right),
        top: round(rect.top),
        bottom: round(rect.bottom),
      },
      messageListRect: {
        left: round(listRect.left),
        right: round(listRect.right),
        top: round(listRect.top),
        bottom: round(listRect.bottom),
      },
      visibleIntersection: {
        left: round(left),
        right: round(right),
        top: round(top),
        bottom: round(bottom),
      },
      intersectsMessageList: right > left && bottom > top,
    };
  });
}

async function measureViewport(page, width, stage) {
  return page.evaluate(
    ({ requestedWidth, stageName }) => {
      const round = (value) => Math.round(value * 10) / 10;
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden";
      };
      const metric = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left: round(rect.left),
          right: round(rect.right),
          top: round(rect.top),
          bottom: round(rect.bottom),
          width: round(rect.width),
          height: round(rect.height),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        };
      };
      const targets = [
        "message-input-root",
        "message-input",
        "send-message",
        "queue-message",
        "queued-messages",
        "queued-message-0",
        "failed-submission",
        "retry-failed-submission",
        "dismiss-failed-submission",
        "conversation-model-selector",
        "workspace-tab-switcher",
        "mobile-drawer",
        "message-list",
      ];
      const controls = targets.flatMap((testId) =>
        [...document.querySelectorAll('[data-testid="' + testId + '"]')]
          .filter(visible)
          .slice(0, 2)
          .map((element) => ({
            testId,
            ...metric(element),
          })),
      );
      const overflowCandidates = [...document.body.querySelectorAll("*")]
        .filter(visible)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(
          ({ element, rect }) =>
            rect.right > window.innerWidth + 1 &&
            getComputedStyle(element).overflowX === "visible",
        )
        .slice(0, 16)
        .map(({ element }) => ({
          tag: element.tagName.toLowerCase(),
          testId: element.getAttribute("data-testid"),
          role: element.getAttribute("role"),
          ...metric(element),
        }));
      const safeAreaProbe = document.createElement("div");
      safeAreaProbe.style.cssText =
        "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom);";
      document.body.appendChild(safeAreaProbe);
      const safeAreaBottom = getComputedStyle(safeAreaProbe).paddingBottom;
      safeAreaProbe.remove();
      const viewportMeta = document.querySelector('meta[name="viewport"]');
      const maxDocumentWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      );
      const richNodes = [...document.querySelectorAll("table, [role='table'], pre")]
        .filter(visible)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          ...metric(element),
        }))
        .slice(0, 24);
      return {
        stage: stageName,
        width: requestedWidth,
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        rootHorizontalOverflow: maxDocumentWidth > window.innerWidth + 1,
        viewportHeight: window.innerHeight,
        visualViewport: window.visualViewport
          ? {
              width: round(window.visualViewport.width),
              height: round(window.visualViewport.height),
              offsetTop: round(window.visualViewport.offsetTop),
              scale: round(window.visualViewport.scale),
            }
          : null,
        viewportMeta: viewportMeta?.content ?? null,
        computedSafeAreaBottom: safeAreaBottom,
        controls,
        overflowCandidates,
        richNodes,
      };
    },
    { requestedWidth: width, stageName: stage },
  );
}

async function targetGeometry(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      testId: element.getAttribute("data-testid"),
      role: element.getAttribute("role"),
      accessibleName: element.getAttribute("aria-label"),
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      left: Math.round(rect.left * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      centerHitWithinTarget:
        Boolean(top) && (top === element || element.contains(top)),
      disabled:
        element.getAttribute("aria-disabled") === "true" ||
        element.hasAttribute("disabled"),
    };
  });
}

function assertFailureRetryGeometry(target) {
  assert.ok(target.width >= 44, `retry touch target width must be at least 44 CSS px; received ${target.width}`);
  assert.ok(target.height >= 44, `retry touch target height must be at least 44 CSS px; received ${target.height}`);
  assert.equal(target.centerHitWithinTarget, true, "the retry target center must hit its own DOM control");
}

function assertFailureTouchTargets(retry, dismiss) {
  assertFailureRetryGeometry(retry);
  assert.equal(dismiss.width, 44, "the dismiss target must be 44 CSS px wide");
  assert.equal(dismiss.height, 44, "the dismiss target must be 44 CSS px high");
  assert.equal(dismiss.centerHitWithinTarget, true, "the dismiss target center must hit its own DOM control");
}

async function tapTargetEdge(page, locator, edge) {
  await locator.scrollIntoViewIfNeeded();
  const bounds = await locator.boundingBox();
  assert.ok(bounds, `touch target must have a viewport box before ${edge} edge tap`);
  const points = {
    top: [bounds.x + bounds.width / 2, bounds.y + 1],
    bottom: [bounds.x + bounds.width / 2, bounds.y + bounds.height - 1],
    left: [bounds.x + 1, bounds.y + bounds.height / 2],
    right: [bounds.x + bounds.width - 1, bounds.y + bounds.height / 2],
  };
  assert.ok(points[edge], `unknown touch target edge: ${edge}`);
  const [x, y] = points[edge];
  const hit = await locator.evaluate((target, point) => {
    const element = document.elementFromPoint(point.x, point.y);
    return {
      withinTarget: Boolean(element) && (element === target || target.contains(element)),
      hitTag: element?.tagName.toLowerCase() ?? null,
      hitTestId: element?.getAttribute("data-testid") ?? null,
      hitRole: element?.getAttribute("role") ?? null,
    };
  }, { x, y });
  assert.equal(hit.withinTarget, true, `the ${edge} edge point must be inside the measured control hit target`);
  await page.touchscreen.tap(x, y);
  return {
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    hit,
    actualTouchIssued: true,
  };
}

function provider(endpoint, defaultModel) {
  return {
    api_format: "openai_chat_completions",
    authentication: { mode: "none" },
    endpoint,
    default_model: defaultModel,
    capabilities: { reasoning: true, vision: false },
    reasoning_effort: "medium",
    reasoning_policy: {
      mode: "optional",
      efforts: ["none", "low", "medium", "high"],
    },
    context_window_tokens: 128_000,
    output_headroom_tokens: 8_192,
    max_output_tokens: 8_192,
    request_timeout_secs: 60,
    no_proxy: true,
    extra_body: {},
  };
}

async function captureOwnedAppServerProvenance(context, gateway, binaryPath, expectedSha256) {
  const configured = await hashExecutableFile(binaryPath);
  assert.equal(
    configured.sha256,
    expectedSha256,
    "the run-owned configured app-server copy must retain its expected bytes",
  );
  const gatewayProcessGroupId = gateway.child.pid;
  assert.ok(Number.isSafeInteger(gatewayProcessGroupId) && gatewayProcessGroupId > 0);
  const processes = await waitFor(
    async () => {
      const observed = await findOwnedExecutableProcesses({
        pgid: gatewayProcessGroupId,
        executablePath: configured.path,
      });
      return observed.length > 0 ? observed : null;
    },
    15_000,
    "the live app-server executable inside this RunContext-owned Gateway process group",
    50,
    context.abortSignal,
  );
  const matchingProcesses = processes.filter(
    (process) => process.sha256 === expectedSha256,
  );
  assert.ok(
    matchingProcesses.length > 0,
    "a live app-server PID in the owned Gateway process group must execute the expected run-owned binary bytes",
  );
  return {
    evidenceScope: "live executable matches restricted to the RunContext-owned Gateway process group",
    gatewayProcessGroupId,
    configuredBinaryPath: configured.path,
    configuredBinarySha256: configured.sha256,
    configuredBinarySize: configured.size,
    actualAppServerProcesses: processes,
    matchingAppServerPids: matchingProcesses.map((process) => process.pid),
    actualExecutableMatchesConfiguredCopy: true,
  };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function preserveMobileWebEntryArtifact(context, webExport) {
  const entries = webExport.bundleFiles.filter(({ path }) =>
    /^_expo\/static\/js\/web\/entry-[A-Za-z0-9_-]+\.js$/.test(path),
  );
  assert.equal(
    entries.length,
    1,
    "the complete Mobile Web export must contain exactly one public web entry bundle",
  );
  const [entry] = entries;
  const entryPath = resolve(webExport.path, ...entry.path.split("/"));
  assert.ok(
    entryPath.startsWith(`${resolve(webExport.path)}/`),
    "the public entry bundle must remain inside this RunContext's export output",
  );
  const entryBytes = await readFile(entryPath);
  const entrySha256 = createHash("sha256").update(entryBytes).digest("hex");
  assert.equal(entryBytes.byteLength, entry.size);
  assert.equal(entrySha256, entry.sha256);

  const artifactPath = context.pathInArtifacts("mobile-web-entry-code.js");
  await writeFile(artifactPath, entryBytes, { flag: "wx", mode: 0o600 });
  const manifestBytes = await readFile(webExport.bundleManifestPath);
  const exportManifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(exportManifest.status, "complete");
  assert.equal(exportManifest.sourceTreeSha256, webExport.sourceTreeSha256);
  assert.equal(exportManifest.bundleSha256, webExport.bundleSha256);

  await context.writeArtifactJson("mobile-web-entry-code-provenance.json", {
    artifactFile: "mobile-web-entry-code.js",
    entryRelativePath: entry.path,
    entrySha256,
    entrySizeBytes: entryBytes.byteLength,
    sourceTreeSha256: webExport.sourceTreeSha256,
    bundleManifestPath: relative(context.runRoot, webExport.bundleManifestPath),
    bundleManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    exportStatus: exportManifest.status,
    bundleSha256: webExport.bundleSha256,
    bundleFileCount: webExport.bundleFileCount,
    indexHtmlSha256: webExport.indexHtmlSha256,
    exporterPid: webExport.exporterPid,
  });
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function connect(page, gateway, beforeGatewayConnect) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  const loginInput = page.locator('input[name="token"]');
  if (await loginInput.count()) {
    await loginInput.fill(gateway.authToken);
    await Promise.all([
      page.waitForSelector('[data-testid="welcome-direct-connection"]', {
        timeout: 30_000,
      }),
      page.locator('button[type="submit"]').tap(),
    ]);
  }
  await page.getByTestId("welcome-direct-connection").tap();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await beforeGatewayConnect?.();
  await page.getByTestId("gateway-connect").tap();
  await page.getByTestId("new-workspace").waitFor({
    state: "visible",
    timeout: 30_000,
  });
}
