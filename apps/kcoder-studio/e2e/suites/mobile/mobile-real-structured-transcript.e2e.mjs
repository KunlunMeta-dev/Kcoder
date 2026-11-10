import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const configuredKcoderBinary = resolve(
  process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/release/kcoder"),
);
const mobileDependencyRoot = resolve(
  process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT ||
    resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
);
const initialPrompt = "MOBILE_STRUCTURED_TRANSCRIPT_KCoder inspect `read` and `src/sample.txt`";
const followupPrompt = "MOBILE_PERMISSION_ASK_SECOND_TURN";
const inlineImageFilename = "mobile-structured-transcript.png";
const inlineImagePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// TodoWrite has a dedicated task-list projection and is not an ordered tool row.
const expectedTools = [
  { id: "tui-lab-mixed-read", name: "read" },
  { id: "tui-lab-mixed-grep", name: "grep" },
  { id: "tui-lab-mixed-edit", name: "edit" },
  { id: "tui-lab-mixed-bash", name: "bash" },
];

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-real-structured-transcript",
    tier: "full-integration",
    modelPolicy:
      "model-independent deterministic mixed-tools scenario through the owned real app-server; no Provider or model request",
    retainSuccessLogs: true,
  },
  async (context) => {
    const configuredBinaryBefore = await hashExecutableFile(configuredKcoderBinary);
    const ownedBinDir = context.pathInState("bin");
    await mkdir(ownedBinDir, { recursive: true, mode: 0o700 });
    const ownedKcoderBinary = resolve(ownedBinDir, "kcoder");
    await copyFile(configuredKcoderBinary, ownedKcoderBinary);
    await chmod(ownedKcoderBinary, 0o700);
    const [configuredBinaryAfterCopy, ownedBinaryBefore] = await Promise.all([
      hashExecutableFile(configuredKcoderBinary),
      hashExecutableFile(ownedKcoderBinary),
    ]);
    assert.equal(
      configuredBinaryAfterCopy.sha256,
      configuredBinaryBefore.sha256,
      "configured app-server binary changed while making the owned run copy",
    );
    assert.equal(
      ownedBinaryBefore.sha256,
      configuredBinaryBefore.sha256,
      "owned app-server binary copy must match the configured binary",
    );

    const mobileWeb = await exportMobileWeb(context, {
      label: "mobile-structured-transcript-export",
      outputName: "mobile-web-export",
      dependencyRoot: mobileDependencyRoot,
      timeoutMs: 10 * 60_000,
    });
    await cp(mobileWeb.path, context.pathInArtifacts("mobile-web-export"), {
      recursive: true, force: false, errorOnExist: true,
    });
    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    await mkdir(resolve(workspace, "src"), { recursive: true });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(workspace, "src/sample.txt"),
      "sample workspace file\n",
      "utf8",
    );
    await context.writeStateJson("config/settings.json", {});
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Local",
        transport: "local",
        command: ownedKcoderBinary,
        workspace,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "mobile-structured-transcript-gateway",
      workspace,
      serversFile,
      kcoderBin: ownedKcoderBinary,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
        KCODER_STUDIO_SCENARIO: "mixed-tools",
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-structured-transcript-chromium",
      startTimeoutMs: 60_000,
    });
    const browserContext = chromium.browser.contexts()[0];
    assert.ok(browserContext, "owned Chromium must expose its isolated context");
    const page = await chromium.newPage();
    // The harness wrapper uses Browser.newPage(), which creates a separate context.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: gateway.baseUrl,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = [];
    const screenshots = [];
    page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        diagnostics.push(`${message.type()}: ${message.text()}`);
    });
    const rpcEvidence = captureAppServerRpc(page, gateway.wsUrl);

    await connect(page, gateway);
    const homeThreadList = await waitFor(
      () => rpcEvidence.threadListResponses.find(
        (row) => row.responseOk && row.resultReceived && row.errorCode === null,
      ),
      15_000,
      "successful home thread/list response",
      50,
      context.abortSignal,
    );
    assert.equal(homeThreadList.scope.server, "local");
    assert.equal(homeThreadList.scope.channel, "runtime");
    await page.getByTestId("new-workspace").waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page.getByTestId("new-workspace").click();
    await page.getByTestId("server-option-local").click();
    await page
      .getByTestId("workspace-path")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("new-workspace-prompt").fill(initialPrompt);
    await page.getByTestId("create-workspace").click();
    await page
      .getByText("tui-lab-mixed-tools-final-sentinel", { exact: false })
      .waitFor({ state: "visible", timeout: 60_000 });

    const firstTurnEvidence = await waitFor(
      () => {
        const turn = rpcEvidence.turnStarts.find((row) => row.response?.ok);
        return turn ? turn : null;
      },
      30_000,
      "successful default turn/start frame",
      50,
      context.abortSignal,
    );
    const serverCapability = rpcEvidence.initializeResponses.find(
      (row) => row.responseOk && row.turnPermissions,
    );
    assert.ok(
      serverCapability,
      "actual app-server initialize response must advertise turnPermissions",
    );
    assert.equal(
      firstTurnEvidence.permissionModePresent,
      false,
      "default permission mode must be omitted from turn/start",
    );
    assert.equal(
      rpcEvidence.turnStarts.filter((row) => row.response?.ok).length,
      1,
      "the deterministic first turn must have one successful turn/start request",
    );

    const firstUserMessage = page.getByTestId("message-user").first();
    const firstAssistantMessage = page
      .locator('[data-testid="message-assistant"]')
      .filter({ hasText: "tui-lab-mixed-tools-final-sentinel" })
      .last();
    await firstAssistantMessage.waitFor({ state: "visible", timeout: 30_000 });

    const processingGroups = firstAssistantMessage.locator(
      '[data-testid^="ordered-message-processing-"]:not([data-testid$="-toggle"]):not([data-testid$="-details"])',
    );
    assert.equal(
      await processingGroups.count(),
      1,
      "consecutive thinking and tool blocks must render as one processing group",
    );
    const processingGroup = processingGroups.first();
    const processingGroupId = await processingGroup.getAttribute("data-testid");
    assert.ok(processingGroupId);
    const processingToggle = firstAssistantMessage.getByTestId(
      `${processingGroupId}-toggle`,
    );
    const processingDetails = firstAssistantMessage.getByTestId(
      `${processingGroupId}-details`,
    );
    assert.equal(await processingToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await processingDetails.count(), 0, "collapsed processing details must be unmounted");
    await processingToggle.click();
    assert.equal(await processingToggle.getAttribute("aria-expanded"), "true");
    await processingDetails.waitFor({ state: "visible", timeout: 30_000 });

    const orderedSegmentSelector =
      '[data-testid^="ordered-message-segment-"]:not([data-testid$="-toggle"]):not([data-testid$="-content"]):not([data-testid$="-more"])';
    const orderedSegmentIds = await processingDetails
      .locator(orderedSegmentSelector)
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-testid")),
      );
    const orderedBlockKinds = orderedSegmentIds.map((id) => {
      if (id?.startsWith("ordered-message-segment-thinking-")) return "thinking";
      if (id?.startsWith("ordered-message-segment-tool-")) return "tool";
      return id;
    });
    const orderedToolIds = orderedSegmentIds
      .filter((id) => id?.startsWith("ordered-message-segment-tool-"))
      .map((id) => id?.slice("ordered-message-segment-tool-".length));
    await context.writeArtifactJson("mobile-structured-transcript-order-observed.json", {
      processingGroupId,
      orderedSegmentIds,
      orderedBlockKinds,
      orderedToolIds,
    });
    assert.deepEqual(
      orderedBlockKinds,
      ["thinking", "tool", "tool", "tool", "tool", "thinking"],
      "expanded processing details must preserve both thoughts around the four ordered tool rows",
    );
    assert.deepEqual(
      orderedToolIds,
      expectedTools.map((tool) => encodeURIComponent(tool.id)),
      "expanded tool rows must retain the app-server event order",
    );

    const timelineObservations = [];
    for (const colorScheme of ["dark", "light"]) {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme });
        await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, colorScheme);
        await processingGroup.scrollIntoViewIfNeeded();
        const steps = await processingDetails.locator(':scope > [data-testid^="processing-step-"]').evaluateAll(elements => elements.map(element => {
          const node = element.querySelector('[data-testid^="transcript-node-"]');
          const chevron = element.querySelector('[data-testid^="transcript-chevron-"]');
          const connector = element.querySelector('[data-testid$="-connector"]');
          const copy = node?.nextElementSibling;
          const label = copy ? document.createTreeWalker(copy, NodeFilter.SHOW_TEXT).nextNode()?.parentElement : null;
          const nodeBox = node?.getBoundingClientRect();
          const chevronBox = chevron?.getBoundingClientRect();
          const connectorStyle = connector ? getComputedStyle(connector) : null;
          return {
            testId: element.getAttribute("data-testid"),
            hasHeader: Boolean(node && chevron),
            nodeX: nodeBox?.x, chevronX: chevronBox?.x,
            connectorStyle: connectorStyle?.borderLeftStyle,
            labelSize: label ? parseFloat(getComputedStyle(label).fontSize) : null,
            labelLineHeight: label ? parseFloat(getComputedStyle(label).lineHeight) : null,
            rowHeight: element.getBoundingClientRect().height,
          };
        }));
        assert.equal(steps.length, 6);
        const thinkingStepIds = new Set(orderedSegmentIds
          .filter(id => id?.startsWith("ordered-message-segment-thinking-"))
          .map(id => `processing-step-${id.slice("ordered-message-segment-thinking-".length)}`));
        const thinkingSteps = steps.filter(step => thinkingStepIds.has(step.testId));
        const toolHeaderSteps = steps.filter(step => step.hasHeader);
        assert.equal(thinkingSteps.length, 2, "both thinking bodies remain separate ordered processing steps");
        assert.equal(toolHeaderSteps.length, expectedTools.length, "tool disclosures keep their own output controls");
        for (const step of steps) {
          assert.equal(step.connectorStyle, "dashed");
        }
        const firstToolHeader = toolHeaderSteps[0];
        assert.ok(firstToolHeader);
        for (const step of toolHeaderSteps) {
          assert.equal(step.nodeX, firstToolHeader.nodeX, "tool disclosure headers must share the left node column");
          assert.equal(step.chevronX, firstToolHeader.chevronX, "tool disclosure headers must share the right disclosure column");
          assert.ok(step.chevronX > step.nodeX);
          assert.equal(step.labelSize, 16);
          assert.equal(step.labelLineHeight, 24);
          assert.ok(step.rowHeight >= 44 && step.rowHeight <= 60, "collapsed steps retain touch targets without oversized empty cards");
        }
        for (const step of thinkingSteps) {
          assert.equal(step.hasHeader, false, "thinking body has no second disclosure header");
        }
        const horizontalOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        assert.ok(
          horizontalOverflow <= 0,
          `${width}px ${colorScheme} processing transcript has ${horizontalOverflow}px horizontal overflow`,
        );
        const screenshot = `mobile-processing-timeline-${width}-${colorScheme}.png`;
        await processingGroup.screenshot({ path: context.pathInArtifacts(screenshot) });
        screenshots.push(`artifacts/${screenshot}`);
        timelineObservations.push({ width, colorScheme, steps, screenshot });
      }
    }
    await context.writeArtifactJson("mobile-processing-timeline-observed.json", timelineObservations);
    // Synthetic wrapping stress changes only the two endpoint labels. The real
    // transport fixture and disclosure state remain unchanged and are restored.
    await processingDetails.evaluate(element => {
      const steps = [...element.querySelectorAll(':scope > [data-testid^="processing-step-"]')];
      const headerSteps = steps.filter(step => step.querySelector('[data-testid^="transcript-node-"]'));
      for (const step of [headerSteps[0], headerSteps.at(-1)]) {
        const copy = step.querySelector('[data-testid^="transcript-node-"]')?.nextElementSibling;
        const label = copy && document.createTreeWalker(copy, NodeFilter.SHOW_TEXT).nextNode();
        if (!label) throw new Error("Missing endpoint label for wrapping stress");
        label.parentElement.dataset.originalTimelineLabel = label.textContent;
        label.textContent = "长标题换行与系统大字布局验证 ".repeat(6);
      }
    });
    await page.waitForFunction(() => {
      const labels = [...document.querySelectorAll('[data-original-timeline-label]')];
      return labels.length === 2 && labels.every(label => {
        const step = label.closest('[data-testid^="processing-step-"]');
        const node = step.querySelector('[data-testid^="transcript-node-"]').getBoundingClientRect();
        const line = step.querySelector('[data-testid$="-connector"]').getBoundingClientRect();
        const center = node.top + node.height / 2;
        return step.getBoundingClientRect().height > 60 && line.top <= center && line.bottom >= center;
      });
    });
    await processingGroup.screenshot({ path: context.pathInArtifacts("mobile-processing-timeline-long-labels.png") });
    await processingDetails.evaluate(element => {
      for (const label of element.querySelectorAll('[data-original-timeline-label]')) {
        label.firstChild.textContent = label.dataset.originalTimelineLabel;
        delete label.dataset.originalTimelineLabel;
      }
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });

    const thinkingSegmentIds = orderedSegmentIds.filter((id) =>
      id?.startsWith("ordered-message-segment-thinking-"),
    );
    assert.equal(
      thinkingSegmentIds.length,
      2,
      "the processing group must preserve both ordered thinking bodies",
    );
    const thinkingRows = thinkingSegmentIds.map((id) => ({
      id,
      row: processingDetails.getByTestId(id),
      content: processingDetails.getByTestId(`${id}-content`),
    }));
    const toolDisclosureToggles = expectedTools.map((tool) =>
      firstAssistantMessage.getByTestId(`tool-call-toggle-${tool.id}`),
    );
    const toolDisclosureStatesBeforeThinking = await Promise.all(
      toolDisclosureToggles.map((toggle) => toggle.getAttribute("aria-expanded")),
    );
    assert.deepEqual(
      toolDisclosureStatesBeforeThinking,
      expectedTools.map(() => "false"),
      "tool outputs start collapsed independently of the processing and thinking rows",
    );
    for (const thinking of thinkingRows) {
      await thinking.content.waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(
        await processingDetails.getByTestId(`${thinking.id}-toggle`).count(),
        0,
        `${thinking.id} must not render a nested thinking toggle`,
      );
    }

    const firstThinking = thinkingRows[0];
    const finalThinking = thinkingRows.at(-1);
    assert.ok(firstThinking);
    assert.ok(finalThinking);
    assert.match(await firstThinking.content.innerText(), /Received user message/);
    assert.match(await firstThinking.content.innerText(), /MOBILE_STRUCTURED_TRANSCRIPT_KCoder/);
    assert.deepEqual(
      await Promise.all(
        toolDisclosureToggles.map((toggle) => toggle.getAttribute("aria-expanded")),
      ),
      toolDisclosureStatesBeforeThinking,
      "opening the processing group must not expand or change any tool output",
    );

    const inlineReadCode = firstThinking.content.getByText("read", { exact: true });
    const inlineFileCode = firstThinking.content.getByRole("link", {
      name: "src/sample.txt",
      exact: true,
    });
    assert.equal(await inlineReadCode.count(), 1, "thinking Markdown must retain its inline `read` code span");
    assert.equal(await inlineFileCode.count(), 1, "workspace paths in thinking Markdown must retain link semantics");
    const inlineThinkingStyles = await Promise.all(
      [inlineReadCode, inlineFileCode].map((element) =>
        element.evaluate((node) => getComputedStyle(node).borderWidth),
      ),
    );
    assert.deepEqual(
      inlineThinkingStyles,
      ["0px", "0px"],
      "inline Markdown code in thinking must have no visible border",
    );
    const inlineFileRole = await inlineFileCode.getAttribute("role");
    assert.equal(inlineFileRole, "link");

    assert.match(await finalThinking.content.innerText(), /Every mixed-tool result entered context/);
    assert.deepEqual(
      await Promise.all(
        toolDisclosureToggles.map((toggle) => toggle.getAttribute("aria-expanded")),
      ),
      toolDisclosureStatesBeforeThinking,
      "showing thinking bodies must leave all tool disclosure states unchanged",
    );
    const thinkingExpandedScreenshot = context.pathInArtifacts("mobile-thinking-group-expanded.png");
    await firstThinking.row.scrollIntoViewIfNeeded();
    await processingGroup.screenshot({ path: thinkingExpandedScreenshot });
    screenshots.push("artifacts/mobile-thinking-group-expanded.png");

    await inlineFileCode.click();
    const linkedFilePanel = page.getByTestId("files-panel");
    await linkedFilePanel.waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("file-editor").waitFor({ state: "visible", timeout: 30_000 });
    const linkedFilePanelText = await linkedFilePanel.innerText();
    const linkedFileContent = await page.getByTestId("file-editor").inputValue();
    assert.match(
      linkedFilePanelText,
      /src\/sample\.txt/,
      "tapping the inline workspace path must open that file in the Files panel",
    );
    assert.match(linkedFileContent, /sample workspace file/);
    await page.getByTestId("task-more").click();
    await page.getByTestId("task-menu-workspace").click();
    await page.getByTestId("workspace-tab-agent").click();
    await firstAssistantMessage.waitFor({ state: "visible", timeout: 30_000 });
    await firstThinking.content.waitFor({ state: "visible", timeout: 30_000 });
    await finalThinking.content.waitFor({ state: "visible", timeout: 30_000 });
    assert.deepEqual(
      await Promise.all(
        toolDisclosureToggles.map((toggle) => toggle.getAttribute("aria-expanded")),
      ),
      toolDisclosureStatesBeforeThinking,
      "opening the linked file must not alter thinking or tool disclosure state",
    );

    await processingToggle.click();
    assert.equal(await processingToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await processingDetails.count(), 0);
    const thinkingCollapsedScreenshot = context.pathInArtifacts("mobile-thinking-group-collapsed.png");
    await processingGroup.screenshot({ path: thinkingCollapsedScreenshot });
    screenshots.push("artifacts/mobile-thinking-group-collapsed.png");
    await processingToggle.click();
    assert.equal(await processingToggle.getAttribute("aria-expanded"), "true");
    await processingDetails.waitFor({ state: "visible", timeout: 30_000 });
    await firstThinking.content.waitFor({ state: "visible", timeout: 30_000 });
    await finalThinking.content.waitFor({ state: "visible", timeout: 30_000 });
    assert.deepEqual(
      await Promise.all(
        toolDisclosureToggles.map((toggle) => toggle.getAttribute("aria-expanded")),
      ),
      toolDisclosureStatesBeforeThinking,
      "collapsing and reopening the processing group must preserve tool output defaults",
    );
    await context.writeArtifactJson("mobile-thinking-disclosures-observed.json", {
      orderedThinkingSegmentIds: thinkingSegmentIds,
      groupInitiallyCollapsed: true,
      groupExpansionShowsAllThinkingBodies: true,
      thinkingHasNoNestedToggle: true,
      groupCollapseHidesAllThinkingBodies: true,
      groupReopenRestoresAllThinkingBodies: true,
      toolDisclosureStatesBeforeThinking,
      toolDisclosureStatesAfterThinking: await Promise.all(
        toolDisclosureToggles.map((toggle) => toggle.getAttribute("aria-expanded")),
      ),
      inlineThinkingStyles: {
        readBorderWidth: inlineThinkingStyles[0],
        workspaceFileBorderWidth: inlineThinkingStyles[1],
        workspaceFileRole: inlineFileRole,
        workspaceFileOpened: /src\/sample\.txt/.test(linkedFilePanelText),
      },
      screenshots: [
        "artifacts/mobile-thinking-group-expanded.png",
        "artifacts/mobile-thinking-group-collapsed.png",
      ],
    });

    await finalThinking.row.waitFor({ state: "visible", timeout: 30_000 });
    await finalThinking.content.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await finalThinking.content.innerText(), /Every mixed-tool result entered context/);
    assert.match(await finalThinking.content.innerText(), /emit the final long-text tail for scroll validation/);
    const finalTextSegment = firstAssistantMessage
      .locator('[data-testid^="ordered-message-segment-text-"]')
      .last();
    await finalTextSegment.waitFor({ state: "visible", timeout: 30_000 });
    const responseInlineReadCode = finalTextSegment.getByText("read", { exact: true });
    const responseInlineFileCode = finalTextSegment.getByRole("link", {
      name: "src/sample.txt",
      exact: true,
    });
    assert.equal(await responseInlineReadCode.count(), 1);
    assert.equal(await responseInlineFileCode.count(), 1);
    const inlineResponseStyles = await Promise.all(
      [responseInlineReadCode, responseInlineFileCode].map((element) =>
        element.evaluate((node) => getComputedStyle(node).borderWidth),
      ),
    );
    assert.deepEqual(
      inlineResponseStyles,
      ["0px", "0px"],
      "inline Markdown code in the assistant response must have no visible border",
    );
    assert.equal(await responseInlineFileCode.getAttribute("role"), "link");
    assert.equal(
      await finalThinking.row.evaluate((thinking) => {
        const text = thinking
          .closest('[data-testid="message-assistant"]')
          ?.querySelector('[data-testid^="ordered-message-segment-text-"]');
        return Boolean(
          text &&
            (thinking.compareDocumentPosition(text) &
              Node.DOCUMENT_POSITION_FOLLOWING),
        );
      }),
      true,
      "visible assistant body text must follow the expanded thinking/tool group",
    );
    const messageOrderBoxes = await Promise.all([
      firstUserMessage.evaluate((element) => {
        const { top, bottom, left, right } = element.getBoundingClientRect();
        return { top, bottom, left, right };
      }),
      firstAssistantMessage.evaluate((element) => {
        const { top, bottom, left, right } = element.getBoundingClientRect();
        return { top, bottom, left, right };
      }),
    ]);
    const [userMessageBox, assistantMessageBox] = messageOrderBoxes;
    const userVisuallyPrecedesAssistant =
      userMessageBox.bottom <= assistantMessageBox.top + 1;
    await context.writeArtifactJson("mobile-transcript-message-order-observed.json", {
      userMessageBox,
      assistantMessageBox,
      userVisuallyPrecedesAssistant,
      domOrderIsInverted: true,
    });
    assert.equal(
      userVisuallyPrecedesAssistant,
      true,
      "the submitted user message must appear above its assistant transcript in the Web viewport",
    );

    for (const tool of expectedTools) {
      const toolCard = firstAssistantMessage.getByTestId(`tool-call-${tool.id}`);
      await toolCard.waitFor({ state: "visible", timeout: 30_000 });
      assert.match(await toolCard.innerText(), new RegExp(escapeRegExp(tool.name), "i"));
      assert.match(await toolCard.innerText(), /完成|completed/i);
    }
    const todo = page.getByTestId("todo-card");
    await todo.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await todo.innerText(), /(?:任务清单|Task list)\s*·\s*0\/2/i);
    assert.equal(await todo.getByRole("button").getAttribute("aria-expanded"), "false");
    await todo.getByRole("button").click();
    assert.equal(await todo.getByRole("button").getAttribute("aria-expanded"), "true");
    assert.match(await todo.innerText(), /Verify mixed tool folding/);
    assert.match(await todo.innerText(), /Check Alt\+T expansion/);

    const readTool = firstAssistantMessage.getByTestId("tool-call-tui-lab-mixed-read");
    await readTool.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await readTool.innerText(), /read/);
    assert.match(await readTool.innerText(), /完成|completed/i);
    const readToolToggle = firstAssistantMessage.getByTestId(
      "tool-call-toggle-tui-lab-mixed-read",
    );
    const bashToolToggle = firstAssistantMessage.getByTestId(
      "tool-call-toggle-tui-lab-mixed-bash",
    );
    assert.equal(await readToolToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await bashToolToggle.getAttribute("aria-expanded"), "false");
    await readToolToggle.click();
    assert.equal(await readToolToggle.getAttribute("aria-expanded"), "true");
    assert.equal(await bashToolToggle.getAttribute("aria-expanded"), "false");
    assert.match(await readTool.innerText(), /输入|input/i);
    assert.match(await readTool.innerText(), /src\/sample\.txt/);
    assert.match(await readTool.innerText(), /输出|output/i);
    assert.match(await readTool.innerText(), /sample workspace file/);
    const bashTool = firstAssistantMessage.getByTestId("tool-call-tui-lab-mixed-bash");
    await bashTool.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await bashTool.innerText(), /完成|completed/i);

    const assistantActions = firstAssistantMessage.getByTestId(
      "assistant-response-actions",
    );
    await assistantActions.waitFor({ state: "visible", timeout: 30_000 });
    const copyButton = firstAssistantMessage.getByTestId("assistant-response-copy");
    assert.equal(await copyButton.count(), 1);
    assert.equal(
      await finalTextSegment.evaluate((text) => {
        const actions = text
          .closest('[data-testid="message-assistant"]')
          ?.querySelector('[data-testid="assistant-response-actions"]');
        return Boolean(
          actions &&
            (text.compareDocumentPosition(actions) &
              Node.DOCUMENT_POSITION_FOLLOWING),
        );
      }),
      true,
      "copy/share actions must follow the visible assistant body",
    );
    const hasWebShare = await page.evaluate(
      () => typeof navigator.share === "function",
    );
    const shareButton = firstAssistantMessage.getByTestId("assistant-response-share");
    assert.equal(
      await shareButton.count(),
      hasWebShare ? 1 : 0,
      "Web share control must match browser WebShare capability; native share is not simulated",
    );

    const standaloneKcoderLabels = firstAssistantMessage.getByText(
      /^\s*KCoder(?:\s+AI)?\s*$/i,
    );
    assert.equal(
      await standaloneKcoderLabels.count(),
      0,
      "assistant must not render a standalone KCoder byline",
    );
    assert.equal(
      await firstAssistantMessage
        .locator('[aria-label="KCoder"], [aria-label="KCoder AI"], [alt="KCoder"], [alt="KCoder AI"]')
        .count(),
      0,
      "assistant must not expose a KCoder byline as an accessibility or image label",
    );

    const expectedClipboardText = createMixedToolsResponse(initialPrompt);
    await copyButton.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: context.pathInArtifacts("mobile-chat-before-clipboard.png"),
    });
    let lastClipboardRead = {
      apiAvailable: false,
      errorName: "not-read-yet",
      textLength: null,
      textSha256: null,
      matchesExpected: false,
    };
    await copyButton.click();
    let clipboardText;
    try {
      clipboardText = await waitFor(
        async () => {
          const observed = await page
            .evaluate(async () => {
              if (typeof navigator.clipboard?.readText !== "function") {
                return { apiAvailable: false, errorName: "ClipboardReadUnavailable" };
              }
              try {
                return { apiAvailable: true, text: await navigator.clipboard.readText() };
              } catch (error) {
                return {
                  apiAvailable: true,
                  errorName:
                    error && typeof error === "object" && "name" in error
                      ? String(error.name)
                      : "ClipboardReadError",
                };
              }
            })
            .catch((error) => ({
              apiAvailable: false,
              errorName: error instanceof Error ? error.name : "ClipboardEvaluationError",
            }));
          const observedText = "text" in observed ? observed.text : null;
          lastClipboardRead = {
            apiAvailable: observed.apiAvailable,
            errorName: observed.errorName ?? null,
            textLength: observedText === null ? null : observedText.length,
            textSha256: observedText === null ? null : sha256(observedText),
            matchesExpected: observedText === expectedClipboardText,
          };
          return observedText === expectedClipboardText ? observedText : null;
        },
        10_000,
        "read-back of assistant response from the real browser clipboard",
        50,
        context.abortSignal,
      );
    } catch (error) {
      const actionFeedback = await firstAssistantMessage
        .getByTestId("assistant-response-action-feedback")
        .textContent()
        .catch(() => null);
      await context.writeArtifactJson("mobile-clipboard-readback-failure.json", {
        expectedTextLength: expectedClipboardText.length,
        expectedTextSha256: sha256(expectedClipboardText),
        lastClipboardRead,
        actionFeedback,
        screenshot: "artifacts/mobile-chat-before-clipboard.png",
        errorName: error instanceof Error ? error.name : "ClipboardReadbackError",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await context.writeArtifactJson("mobile-clipboard-readback.json", {
      expectedTextLength: expectedClipboardText.length,
      expectedTextSha256: sha256(expectedClipboardText),
      actualTextLength: clipboardText.length,
      actualTextSha256: sha256(clipboardText),
      readBackMatchesExpected: clipboardText === expectedClipboardText,
      screenshot: "artifacts/mobile-chat-before-clipboard.png",
    });
    assert.equal(clipboardText, expectedClipboardText);
    assert.doesNotMatch(clipboardText, /Received user message|Every mixed-tool result entered context/);
    assert.doesNotMatch(clipboardText, /tui-lab-mixed-read|tui-lab-mixed-bash/);
    assert.match(clipboardText, /tui-lab-mixed-tools-final-sentinel/);
    assert.match(clipboardText, /MOBILE_STRUCTURED_TRANSCRIPT_KCoder/);

    await processingToggle.click();
    assert.equal(await processingToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await processingDetails.count(), 0);
    const userBubble = firstUserMessage.locator(":scope > *").first();
    const visualEvidence = [];
    for (const colorScheme of ["light", "dark"]) {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme });
        await page.waitForFunction(
          (expected) => document.documentElement.style.colorScheme === expected,
          colorScheme,
          { timeout: 10_000 },
        );
        await firstUserMessage.scrollIntoViewIfNeeded();
        const screenshotPath = context.pathInArtifacts(
          `mobile-chat-user-${width}-${colorScheme}.png`,
        );
        await page.screenshot({ path: screenshotPath });
        screenshots.push(`artifacts/mobile-chat-user-${width}-${colorScheme}.png`);
        const style = await userBubble.evaluate((element) => {
          const computed = getComputedStyle(element);
          return {
            backgroundColor: computed.backgroundColor,
            borderTopLeftRadius: computed.borderTopLeftRadius,
            borderTopRightRadius: computed.borderTopRightRadius,
            borderBottomLeftRadius: computed.borderBottomLeftRadius,
            borderBottomRightRadius: computed.borderBottomRightRadius,
          };
        });
        const expectedColor = colorScheme === "dark" ? "rgb(41, 41, 46)" : "rgb(243, 244, 246)";
        assert.equal(style.backgroundColor, expectedColor);
        for (const cornerRadius of [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomLeftRadius,
          style.borderBottomRightRadius,
        ]) {
          assert.ok(
            Number.parseFloat(cornerRadius) >= 20,
            `user message corner radius should be at least 20px, got ${cornerRadius}`,
          );
        }
        const horizontalOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        assert.ok(
          horizontalOverflow <= 0,
          `${width}px ${colorScheme} chat has ${horizontalOverflow}px horizontal overflow`,
        );
        const permissionButton = page.getByTestId("composer-permission-selector");
        const modelButton = page.getByTestId("conversation-model-selector");
        await permissionButton.waitFor({ state: "visible", timeout: 30_000 });
        const [permissionBounds, modelBounds] = await Promise.all([
          permissionButton.boundingBox(),
          modelButton.boundingBox(),
        ]);
        assert.ok(permissionBounds);
        assert.ok(modelBounds);
        assert.ok(permissionBounds.width >= 44, `permission control must be at least 44px wide, got ${permissionBounds.width}`);
        assert.ok(permissionBounds.height >= 44, `permission control must be at least 44px high, got ${permissionBounds.height}`);
        assert.ok(permissionBounds.x >= 0 && permissionBounds.x + permissionBounds.width <= width + 1, `${width}px permission control must stay in viewport`);
        assert.ok(modelBounds.width >= 64, `${width}px model selector needs readable space, got ${modelBounds.width}px`);
        assert.ok(modelBounds.x + modelBounds.width <= permissionBounds.x + 1, `${width}px model and permission controls must not overlap`);
        assert.match(await permissionButton.innerText(), /(?:权限|permissions?).*(?:默认|default)/i);
        visualEvidence.push({ width, colorScheme, ...style, horizontalOverflow });
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(
      () => document.documentElement.style.colorScheme === "dark",
      null,
      { timeout: 10_000 },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByText("tui-lab-mixed-tools-final-sentinel", { exact: false })
      .waitFor({ state: "visible", timeout: 30_000 });
    const reloadedAssistant = page
      .locator('[data-testid="message-assistant"]')
      .filter({ hasText: "tui-lab-mixed-tools-final-sentinel" })
      .last();
    const reloadedGroups = reloadedAssistant.locator(
      '[data-testid^="ordered-message-processing-"]:not([data-testid$="-toggle"]):not([data-testid$="-details"])',
    );
    await reloadedGroups.first().waitFor({ state: "attached", timeout: 30_000 });
    assert.equal(await reloadedGroups.count(), 1);
    const reloadedGroup = reloadedGroups.first();
    const reloadedGroupId = await reloadedGroup.getAttribute("data-testid");
    assert.ok(reloadedGroupId);
    const reloadedToggle = reloadedAssistant.getByTestId(`${reloadedGroupId}-toggle`);
    const reloadedDetails = reloadedAssistant.getByTestId(`${reloadedGroupId}-details`);
    assert.equal(await reloadedToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await reloadedDetails.count(), 0);
    await reloadedToggle.click();
    assert.equal(await reloadedToggle.getAttribute("aria-expanded"), "true");
    await reloadedDetails.waitFor({ state: "visible", timeout: 30_000 });
    const reloadedSegmentIds = await reloadedDetails
      .locator(orderedSegmentSelector)
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-testid")),
      );
    assert.deepEqual(
      reloadedSegmentIds.filter((id) => id?.startsWith("ordered-message-segment-tool-")),
      expectedTools.map(
        (tool) => `ordered-message-segment-tool-${encodeURIComponent(tool.id)}`,
      ),
      "tool rows and their order must survive page reload",
    );
    const reloadedThinkingIds = reloadedSegmentIds.filter((id) =>
      id?.startsWith("ordered-message-segment-thinking-"),
    );
    assert.equal(reloadedThinkingIds.length, 2);
    const reloadedThinkingRows = reloadedThinkingIds.map((id) => ({
      id,
      content: reloadedAssistant.getByTestId(`${id}-content`),
    }));
    for (const thinking of reloadedThinkingRows) {
      await thinking.content.waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(
        await reloadedDetails.getByTestId(`${thinking.id}-toggle`).count(),
        0,
        `${thinking.id} must not restore a nested thinking toggle after reload`,
      );
    }
    const reloadedFinalThinking = reloadedThinkingRows.at(-1);
    assert.ok(reloadedFinalThinking);
    assert.match(await reloadedFinalThinking.content.innerText(), /emit the final long-text tail for scroll validation/);
    const reloadedTodo = page.getByTestId("todo-card");
    await reloadedTodo.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await reloadedTodo.innerText(), /(?:任务清单|Task list)\s*·\s*0\/2/i);
    assert.equal(await reloadedTodo.getByRole("button").getAttribute("aria-expanded"), "false");
    await reloadedTodo.getByRole("button").click();
    assert.equal(await reloadedTodo.getByRole("button").getAttribute("aria-expanded"), "true");
    assert.match(await reloadedTodo.innerText(), /Verify mixed tool folding/);
    assert.match(await reloadedTodo.innerText(), /Check Alt\+T expansion/);
    const reloadedReadTool = reloadedAssistant.getByTestId("tool-call-tui-lab-mixed-read");
    await reloadedReadTool.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await reloadedReadTool.innerText(), /完成|completed/i);
    const reloadedReadToolToggle = reloadedAssistant.getByTestId(
      "tool-call-toggle-tui-lab-mixed-read",
    );
    const reloadedBashToolToggle = reloadedAssistant.getByTestId(
      "tool-call-toggle-tui-lab-mixed-bash",
    );
    assert.equal(await reloadedReadToolToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await reloadedBashToolToggle.getAttribute("aria-expanded"), "false");
    await reloadedReadToolToggle.click();
    assert.equal(await reloadedReadToolToggle.getAttribute("aria-expanded"), "true");
    assert.match(await reloadedReadTool.innerText(), /src\/sample\.txt/);
    assert.match(await reloadedReadTool.innerText(), /sample workspace file/);

    const composerRoot = page.getByTestId("message-input-root");
    const composerInput = page.getByTestId("message-input");
    const originalInputHandle = await composerInput.elementHandle();
    assert.ok(originalInputHandle, "composer textarea must be mounted");
    const measureComposer = () => composerRoot.evaluate((root) => {
      const area = root.querySelector('[data-testid="message-input-area"]');
      const input = root.querySelector('[data-testid="message-input"]');
      if (!(area instanceof HTMLElement) || !(input instanceof HTMLElement)) return null;
      return {
        rootHeight: root.getBoundingClientRect().height,
        areaHeight: area.getBoundingClientRect().height,
        inputHeight: input.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(input).lineHeight),
        paddingTop: Number.parseFloat(getComputedStyle(input).paddingTop),
      };
    });
    const initialComposer = await measureComposer();
    assert.ok(initialComposer);
    assert.ok(initialComposer.rootHeight >= 52 && initialComposer.rootHeight <= 60,
      `empty composer should start near 56px, got ${initialComposer.rootHeight}px`);
    assert.ok(initialComposer.areaHeight >= 54 && initialComposer.areaHeight <= 58,
      `empty composer input area should be one line / 56px, got ${initialComposer.areaHeight}px`);
    assert.ok(initialComposer.paddingTop >= 11 && initialComposer.paddingTop <= 12,
      `collapsed Web textarea should center its 21px line with about 11.5px vertical padding, got ${initialComposer.paddingTop}px`);

    // Use a real browser click at the center so overlays cannot be bypassed by focus().
    await composerInput.click();
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="message-input"]');
      const area = document.querySelector('[data-testid="message-input-area"]');
      return input && area && document.activeElement === input && area.getBoundingClientRect().height >= 100;
    }, null, { timeout: 10_000 });
    const focusedComposer = await measureComposer();
    assert.ok(focusedComposer);
    assert.ok(Math.abs(focusedComposer.inputHeight - focusedComposer.lineHeight * 2) <= 3,
      `focused composer input should show two lines, got ${focusedComposer.inputHeight}px at ${focusedComposer.lineHeight}px line height`);
    assert.equal(
      await originalInputHandle.evaluate((input) => input === document.querySelector('[data-testid="message-input"]')),
      true,
      "focus expansion must preserve the actual textarea DOM node",
    );

    const modelButton = page.getByTestId("conversation-model-selector");
    await modelButton.click();
    const modelDialog = page.getByRole("dialog").last();
    await modelDialog.waitFor({ state: "visible", timeout: 10_000 });
    const composerWithModelDialog = await measureComposer();
    assert.ok(composerWithModelDialog && composerWithModelDialog.areaHeight >= 100,
      "opening the model sheet must keep the empty focused composer expanded until the modal is visible");
    await modelDialog.getByLabel(/关闭|close/i).click();
    await modelDialog.waitFor({ state: "hidden", timeout: 10_000 });
    await page.waitForFunction(() => {
      const area = document.querySelector('[data-testid="message-input-area"]');
      return area && area.getBoundingClientRect().height <= 60;
    }, null, { timeout: 10_000 });

    await composerInput.click();
    const longDraft = Array.from({ length: 8 }, (_, index) =>
      `draft line ${index + 1} ${"word ".repeat(12)}`,
    ).join("\n");
    await composerInput.fill(longDraft);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="message-input"]');
      if (!(input instanceof HTMLElement)) return false;
      const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
      return input.getBoundingClientRect().height >= lineHeight * 5 - 2;
    }, null, { timeout: 10_000 });
    const cappedComposer = await measureComposer();
    assert.ok(cappedComposer);
    assert.ok(cappedComposer.inputHeight <= cappedComposer.lineHeight * 5 + 3,
      `long composer draft must stop at five visible lines, got ${cappedComposer.inputHeight}px`);
    await composerInput.press("Tab");
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-testid") !== "message-input",
      null,
      { timeout: 5_000 },
    );
    assert.equal(await composerInput.inputValue(), longDraft, "blur must retain the composer draft");
    const retainedAfterBlur = (await composerInput.inputValue()) === longDraft;
    assert.equal(
      await originalInputHandle.evaluate((input) => input === document.querySelector('[data-testid="message-input"]')),
      true,
      "draft edits and blur must preserve the actual textarea DOM node",
    );
    await composerInput.fill("");
    await composerInput.press("Tab");
    const toolbarFocus = await composerRoot.evaluate((root) => ({
      remainsInside: root.contains(document.activeElement),
      areaHeight: root.querySelector('[data-testid="message-input-area"]')?.getBoundingClientRect().height ?? null,
    }));
    assert.equal(toolbarFocus.remainsInside, true, "the first Tab must move focus into the composer toolbar");
    assert.ok(toolbarFocus.areaHeight && toolbarFocus.areaHeight > 60,
      "moving focus from the input into its toolbar must keep the composer expanded");
    for (let index = 0; index < 20; index += 1) {
      const remainsInside = await composerRoot.evaluate((root) => root.contains(document.activeElement));
      if (!remainsInside) break;
      await page.keyboard.press("Tab");
    }
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-testid="message-input-root"]');
      const area = document.querySelector('[data-testid="message-input-area"]');
      return root && !root.contains(document.activeElement) && area && area.getBoundingClientRect().height <= 60;
    }, null, { timeout: 10_000 });
    const composerEvidence = {
      default: initialComposer,
      focused: focusedComposer,
      expandedWhileModelDialogVisible: composerWithModelDialog.areaHeight,
      longDraft: {
        lines: 8,
        renderedInputHeight: cappedComposer.inputHeight,
        maximumLines: 5,
        retainedAfterBlur,
      },
      textareaDomIdentityPreserved: true,
    };

    const permissionButton = page.getByTestId("composer-permission-selector");
    await permissionButton.waitFor({ state: "visible", timeout: 30_000 });
    const defaultPermissionLabel = await permissionButton.getAttribute("aria-label");
    assert.ok(defaultPermissionLabel?.trim(), "permission selector must have a current-mode label");
    await permissionButton.click();
    const permissionSheet = page.getByTestId("permission-mode-sheet");
    await permissionSheet.waitFor({ state: "visible", timeout: 10_000 });
    const composerWithPermissionSheet = await measureComposer();
    assert.ok(
      composerWithPermissionSheet && composerWithPermissionSheet.areaHeight >= 100,
      "opening the permission sheet must keep the empty composer expanded until the sheet is visible",
    );
    composerEvidence.expandedWhilePermissionSheetVisible = composerWithPermissionSheet.areaHeight;
    const permissionDialog = page.getByRole("dialog").last();
    const permissionDialogBounds = await permissionDialog.boundingBox();
    assert.ok(permissionDialogBounds);
    assert.ok(permissionDialogBounds.x >= 0 && permissionDialogBounds.x + permissionDialogBounds.width <= 391);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.waitForFunction(() => document.documentElement.clientWidth === 320, null, { timeout: 10_000 });
    const narrowPermissionDialogBounds = await permissionDialog.boundingBox();
    assert.ok(narrowPermissionDialogBounds);
    assert.ok(
      narrowPermissionDialogBounds.x >= 0 && narrowPermissionDialogBounds.x + narrowPermissionDialogBounds.width <= 321,
      "permission sheet must stay inside the 320px viewport",
    );
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "permission sheet must not introduce horizontal overflow at 320px",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.documentElement.clientWidth === 390, null, { timeout: 10_000 });
    const permissionSheetScreenshot = context.pathInArtifacts(
      "mobile-permission-mode-sheet-default.png",
    );
    await page.screenshot({ path: permissionSheetScreenshot });
    screenshots.push("artifacts/mobile-permission-mode-sheet-default.png");
    assert.match(await permissionSheet.innerText(), /后续发送|future submissions/i);
    const permissionModes = [
      "default",
      "ask",
      "auto",
      "accept_edits",
      "dont_ask",
      "bypass",
      "yolo",
    ];
    for (const mode of permissionModes) {
      const option = page.getByTestId(`permission-mode-${mode}`);
      await option.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await option.getAttribute("role"), "radio");
    }
    const defaultPermissionOption = page.getByTestId("permission-mode-default");
    const askPermissionOption = page.getByTestId("permission-mode-ask");
    assert.equal(await defaultPermissionOption.getAttribute("aria-checked"), "true");
    assert.equal(await askPermissionOption.getAttribute("aria-checked"), "false");
    await askPermissionOption.click();
    await permissionSheet.waitFor({ state: "hidden", timeout: 10_000 });
    const askSelectedScreenshot = context.pathInArtifacts(
      "mobile-permission-mode-ask-selected.png",
    );
    await page.screenshot({ path: askSelectedScreenshot });
    screenshots.push("artifacts/mobile-permission-mode-ask-selected.png");
    const askPermissionLabel = await permissionButton.getAttribute("aria-label");
    assert.ok(askPermissionLabel?.trim());
    assert.notEqual(askPermissionLabel, defaultPermissionLabel);
    await permissionButton.click();
    await permissionSheet.waitFor({ state: "visible", timeout: 10_000 });
    const permissionSheetAskScreenshot = context.pathInArtifacts(
      "mobile-permission-mode-sheet-ask.png",
    );
    await page.screenshot({ path: permissionSheetAskScreenshot });
    screenshots.push("artifacts/mobile-permission-mode-sheet-ask.png");
    assert.equal(await page.getByTestId("permission-mode-ask").getAttribute("aria-checked"), "true");
    assert.equal(await page.getByTestId("permission-mode-default").getAttribute("aria-checked"), "false");
    await page.getByTestId("permission-mode-close").click();
    await permissionSheet.waitFor({ state: "hidden", timeout: 10_000 });

    const demoPage = await chromium.newPage();
    demoPage.on("pageerror", (error) => diagnostics.push(`demo pageerror: ${error.message}`));
    demoPage.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        diagnostics.push(`demo ${message.type()}: ${message.text()}`);
    });
    await demoPage.setViewportSize({ width: 390, height: 844 });
    await demoPage.goto(`${gateway.baseUrl}/?demo=1`, { waitUntil: "domcontentloaded" });
    const demoThreadToggle = demoPage.getByTestId("toggle-server-local");
    await demoThreadToggle.waitFor({ state: "visible", timeout: 30_000 });
    if ((await demoThreadToggle.getAttribute("aria-expanded")) === "false")
      await demoThreadToggle.click();
    const demoThread = demoPage.getByTestId("thread-demo-1");
    await demoThread.waitFor({ state: "visible", timeout: 15_000 });
    await demoThread.click();
    const demoComposer = demoPage.getByTestId("message-input");
    await demoComposer.waitFor({ state: "visible", timeout: 30_000 });

    const demoPermissionButton = demoPage.getByTestId("composer-permission-selector");
    await demoPermissionButton.click();
    const demoPermissionSheet = demoPage.getByTestId("permission-mode-sheet");
    await demoPermissionSheet.waitFor({ state: "visible", timeout: 10_000 });
    const demoPermissionCopy = await demoPermissionSheet.innerText();
    assert.match(demoPermissionCopy, /演示预览|demo preview only/i);
    for (const mode of permissionModes) {
      const option = demoPage.getByTestId(`permission-mode-${mode}`);
      await option.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await option.getAttribute("role"), "radio");
      assert.equal(await option.getAttribute("aria-disabled"), "true", `${mode} demo option must be read-only`);
    }
    assert.equal(await demoPage.getByTestId("permission-mode-default").getAttribute("aria-checked"), "true");
    await demoPage.getByTestId("permission-mode-close").click();
    await demoPermissionSheet.waitFor({ state: "hidden", timeout: 10_000 });

    await demoPage.getByTestId("composer-attachment").click();
    const photoChooserPromise = demoPage.waitForEvent("filechooser");
    await demoPage.getByText(/照片图库|photo library/i).click();
    const photoChooser = await photoChooserPromise;
    await photoChooser.setFiles({
      name: inlineImageFilename,
      mimeType: "image/png",
      buffer: inlineImagePng,
    });
    const imageTestId = `composer-image-attachment-${encodeURIComponent(inlineImageFilename)}`;
    const stagedImage = demoPage.getByTestId(imageTestId);
    await stagedImage.waitFor({ state: "visible", timeout: 15_000 });
    await demoPage.waitForFunction((testId) => {
      const image = document.querySelector(`[data-testid="${testId}"] img`);
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    }, imageTestId, { timeout: 15_000 });
    const demoImageScreenshot = context.pathInArtifacts("mobile-chat-demo-image-preview.png");
    await demoPage.screenshot({ path: demoImageScreenshot });
    screenshots.push("artifacts/mobile-chat-demo-image-preview.png");
    await demoPage.getByTestId(`composer-remove-attachment-${encodeURIComponent(inlineImageFilename)}`).click();
    await stagedImage.waitFor({ state: "detached", timeout: 10_000 });
    const demoEvidence = {
      permissionModesReadOnly: permissionModes,
      permissionSheetCopy: demoPermissionCopy,
      imagePreview: {
        filename: inlineImageFilename,
        imageDecodedInBrowser: true,
        removedFromComposer: true,
        evidenceScope: "local Web demo fixture; no native photo picker or app-server attachment/read claim",
      },
    };
    await demoPage.close();

    await page.getByTestId("message-input").fill(followupPrompt);
    await page.getByTestId("send-message").click();
    await page
      .getByText("tui-lab-second-turn-sentinel", { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 60_000 });

    const sentinelTextSegmentsAtVisibility = await captureSentinelTextSegments(
      page,
      "tui-lab-second-turn-sentinel",
    );
    await context.writeArtifactJson("mobile-permission-rpc-observed.json", {
      observation: "sentinel-visible",
      assistantItemEvents: rpcEvidence.assistantItemEvents,
      turnStarts: rpcEvidence.turnStarts,
      matchingSentinelTextSegments: sentinelTextSegmentsAtVisibility,
    });

    const askTurnEvidence = await waitFor(
      () => {
        const matching = rpcEvidence.turnStarts.filter(
          (row) => row.permissionModePresent && row.permissionMode === "ask",
        );
        const turn = matching.at(-1);
        return turn?.response?.ok ? turn : null;
      },
      30_000,
      "successful ask permissionMode turn/start and app-server response",
      50,
      context.abortSignal,
    );
    const sentinelTextSegmentsAfterTurnResponse = await captureSentinelTextSegments(
      page,
      "tui-lab-second-turn-sentinel",
    );
    const rpcObservation = {
      observation: "successful-ask-turn-start-response",
      assistantItemEvents: rpcEvidence.assistantItemEvents,
      turnStarts: rpcEvidence.turnStarts,
      matchingSentinelTextSegments: sentinelTextSegmentsAfterTurnResponse,
      matchingServerAssistantItems: correlateSentinelSegments(
        sentinelTextSegmentsAfterTurnResponse,
        rpcEvidence.assistantItemEvents,
      ),
    };
    await context.writeArtifactJson("mobile-permission-rpc-final.json", rpcObservation);

    assert.equal(askTurnEvidence.permissionMode, "ask");
    assert.equal(askTurnEvidence.response.ok, true);
    assert.equal(
      rpcEvidence.turnStarts.filter((row) => row.permissionModePresent && row.permissionMode === "ask").length,
      1,
      "the explicit ask choice must be sent for exactly the follow-up turn",
    );

    const askTurnResponseScreenshot = context.pathInArtifacts(
      "mobile-permission-ask-turn-response.png",
    );
    await page.screenshot({ path: askTurnResponseScreenshot });
    screenshots.push("artifacts/mobile-permission-ask-turn-response.png");

    const followupAssistant = page
      .locator('[data-testid="message-assistant"]')
      .filter({ hasText: "tui-lab-second-turn-sentinel" })
      .last();
    const followupActions = followupAssistant.getByTestId(
      "assistant-response-actions",
    );
    await followupActions.waitFor({ state: "visible", timeout: 30_000 });
    for (const colorScheme of ["light", "dark"]) {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme });
        await page.waitForFunction(
          (expected) => document.documentElement.style.colorScheme === expected,
          colorScheme,
          { timeout: 10_000 },
        );
        const horizontalOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        assert.ok(
          horizontalOverflow <= 0,
          `${width}px ${colorScheme} assistant footer has ${horizontalOverflow}px horizontal overflow`,
        );
        await followupActions.scrollIntoViewIfNeeded();
        const screenshotPath = context.pathInArtifacts(
          `mobile-chat-${width}-${colorScheme}.png`,
        );
        await page.screenshot({ path: screenshotPath });
        screenshots.push(`artifacts/mobile-chat-${width}-${colorScheme}.png`);
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await followupActions.scrollIntoViewIfNeeded();
    const responseActionsScreenshot = context.pathInArtifacts(
      "mobile-chat-response-actions.png",
    );
    await page.screenshot({ path: responseActionsScreenshot });
    screenshots.push("artifacts/mobile-chat-response-actions.png");

    assert.deepEqual(diagnostics, []);
    const gatewayProcessGroupId = gateway.child.pid;
    const ownedBackendProcesses = await findOwnedExecutableProcesses({
      pgid: gatewayProcessGroupId,
      executablePath: ownedBinaryBefore.path,
    });
    const [configuredBinaryAfter, ownedBinaryAfter] = await Promise.all([
      hashExecutableFile(configuredKcoderBinary),
      hashExecutableFile(ownedKcoderBinary),
    ]);
    const configuredBinaryUnchanged =
      configuredBinaryAfter.sha256 === configuredBinaryBefore.sha256;
    const ownedBinaryUnchanged =
      ownedBinaryAfter.sha256 === ownedBinaryBefore.sha256;
    const actualExecutableVerified = ownedBackendProcesses.some(
      (item) => item.sha256 === ownedBinaryBefore.sha256,
    );
    const backendBinaryProvenance = {
      sourceBinding: "UNVERIFIED",
      configuredBefore: configuredBinaryBefore,
      configuredAfter: configuredBinaryAfter,
      ownedPathRelativeToRun: "state/bin/kcoder",
      ownedBefore: ownedBinaryBefore,
      ownedAfter: ownedBinaryAfter,
      configuredUnchanged: configuredBinaryUnchanged,
      ownedUnchanged: ownedBinaryUnchanged,
      gatewayProcessGroupId,
      status: actualExecutableVerified ? "verified" : "unverified",
      ownedProcesses: ownedBackendProcesses,
      unverifiedReason: actualExecutableVerified
        ? null
        : "no readable matching owned app-server executable found in this run's Gateway process group",
    };
    await context.writeArtifactJson(
      "mobile-backend-binary-provenance.json",
      backendBinaryProvenance,
    );
    assert.equal(configuredBinaryUnchanged, true, "configured KCoder binary changed during this run");
    assert.equal(ownedBinaryUnchanged, true, "owned KCoder app-server binary changed during this run");
    assert.equal(actualExecutableVerified, true, "Gateway must run the exact owned app-server binary copy");

    const copyEvidence = {
      readBackMatchesVisibleAssistantText: clipboardText === expectedClipboardText,
      copiedTextLength: clipboardText.length,
      copiedTextSha256: sha256(clipboardText),
      excludedThinkingAndToolPayload: true,
    };
    const permissionEvidence = {
      initializeCapability: serverCapability.turnPermissions,
      defaultPermissionModeOmitted: !firstTurnEvidence.permissionModePresent,
      explicitAskModeSent: askTurnEvidence.permissionMode === "ask",
      explicitAskTurnStartResponseOk: askTurnEvidence.response.ok,
      modesExposedAsRadioOptions: permissionModes,
    };
    await context.writeArtifactJson("mobile-real-structured-transcript.json", {
      sourceBinding: "UNVERIFIED",
      modelBoundary: "deterministic mixed-tools scenario through the actual local app-server; no Provider/model request",
      mobileWebExport: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        bundleManifestPath: mobileWeb.bundleManifestPath,
        dependencyRoot: mobileDependencyRoot,
        dependencyPinCreatedAt: process.env.KCODER_E2E_MOBILE_DEPENDENCY_PIN_CREATED_AT || null,
      },
      backendBinary: backendBinaryProvenance,
      appServerRpc: {
        initializeResponses: rpcEvidence.initializeResponses,
        homeThreadListResponse: homeThreadList,
        threadListResponses: rpcEvidence.threadListResponses,
        turnStarts: rpcEvidence.turnStarts,
        assistantItemEvents: rpcEvidence.assistantItemEvents,
        modelOrProviderRequest: false,
      },
      transcript: {
        collapsedByDefault: true,
        expandedBlockKinds: orderedBlockKinds,
        expandedToolOrder: orderedToolIds,
        processingGroupThinking: {
          orderedThinkingSegmentIds: thinkingSegmentIds,
          groupCollapsedByDefault: true,
          groupExpansionShowsThinkingWithoutNestedToggle: true,
          groupCollapseAndReopen: true,
          toolDisclosureStatesUnchanged: toolDisclosureStatesBeforeThinking.every(
            (state) => state === "false",
          ),
          restoredGroupedStateAfterReload: true,
          inlineThinkingBorderWidths: inlineThinkingStyles,
          inlineAssistantBorderWidths: inlineResponseStyles,
          workspaceFileInlineRole: inlineFileRole,
          workspaceFileOpenedInFilesPanel: /src\/sample\.txt/.test(linkedFilePanelText),
          screenshots: [
            "artifacts/mobile-thinking-group-expanded.png",
            "artifacts/mobile-thinking-group-collapsed.png",
          ],
        },
        bodyFollowsProcessingGroup: true,
        durableAfterReload: ["thinking", "tools", "todo", "read-tool-input-output"],
        followupSentinelSegments: sentinelTextSegmentsAfterTurnResponse,
        followupSegmentServerItemCorrelation: rpcObservation.matchingServerAssistantItems,
      },
      assistantBylineAbsent: true,
      clipboard: copyEvidence,
      webShare: {
        available: hasWebShare,
        buttonVisible: (await shareButton.count()) === 1,
        invoked: false,
      },
      permissions: permissionEvidence,
      composer: composerEvidence,
      demoWebFixture: demoEvidence,
      screenshots,
      visualEvidence,
      diagnostics,
    });
    return {
      modelBoundary:
        "deterministic mixed-tools scenario through the actual local app-server; no Provider/model request",
      transcript: {
        collapsedByDefault: true,
        expandedBlockKinds: orderedBlockKinds,
        expandedToolOrder: orderedToolIds,
        durableAfterReload: ["thinking", "tools", "todo", "read-tool-input-output"],
      },
      permissions: permissionEvidence,
      composer: composerEvidence,
      demoWebFixture: demoEvidence,
      clipboard: copyEvidence,
      webShareAvailable: hasWebShare,
      screenshots,
      mobileWebExport: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        bundleManifestPath: mobileWeb.bundleManifestPath,
      },
      backendBinary: backendBinaryProvenance,
    };
  },
);

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page
    .getByTestId("welcome-direct-connection")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

function captureAppServerRpc(page, gatewayWebSocketPrefix) {
  const evidence = {
    initializeResponses: [],
    threadListResponses: [],
    turnStarts: [],
    assistantItemEvents: [],
  };
  page.on("websocket", (socket) => {
    let scope;
    try {
      const socketUrl = new URL(socket.url());
      const gatewayUrl = new URL(gatewayWebSocketPrefix);
      scope = {
        server: socketUrl.searchParams.get("server"),
        channel: socketUrl.searchParams.get("channel"),
      };
      if (
        socketUrl.origin !== gatewayUrl.origin ||
        socketUrl.pathname !== "/rpc" ||
        scope.server !== "local" ||
        scope.channel !== "runtime"
      ) {
        return;
      }
    } catch {
      return;
    }
    const pending = new Map();
    socket.on("framesent", ({ payload }) => {
      for (const message of parseJsonMessages(payload)) {
        if (!message || typeof message !== "object" || typeof message.method !== "string")
          continue;
        if (message.method === "initialize" && message.id !== undefined) {
          pending.set(String(message.id), { method: "initialize" });
        } else if (message.method === "thread/list" && message.id !== undefined) {
          pending.set(String(message.id), { method: "thread/list" });
        } else if (message.method === "turn/start" && message.id !== undefined) {
          const params = message.params && typeof message.params === "object"
            ? message.params
            : {};
          const record = {
            permissionModePresent: Object.hasOwn(params, "permissionMode"),
            permissionMode: Object.hasOwn(params, "permissionMode")
              ? params.permissionMode
              : null,
            response: null,
          };
          evidence.turnStarts.push(record);
          pending.set(String(message.id), { method: "turn/start", record });
        }
      }
    });
    socket.on("framereceived", ({ payload }) => {
      for (const message of parseJsonMessages(payload)) {
        if (
          message &&
          typeof message === "object" &&
          ["item/started", "item/completed"].includes(message.method)
        ) {
          const params = message.params && typeof message.params === "object"
            ? message.params
            : {};
          const item = params.item && typeof params.item === "object"
            ? params.item
            : {};
          if (item.type === "agentMessage") {
            evidence.assistantItemEvents.push({
              method: message.method,
              agentMessageId: item.id ?? null,
              turnId: params.turnId ?? item.turnId ?? null,
            });
          }
        }
        if (
          !message ||
          typeof message !== "object" ||
          message.id === undefined ||
          (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))
        ) {
          continue;
        }
        const request = pending.get(String(message.id));
        if (!request) continue;
        pending.delete(String(message.id));
        if (request.method === "initialize") {
          const experimental = message.result?.capabilities?.experimental ?? {};
          evidence.initializeResponses.push({
            responseOk: !message.error,
            turnPermissions: experimental.turnPermissions === true,
          });
        } else if (request.method === "thread/list") {
          evidence.threadListResponses.push({
            responseOk: !message.error && Object.hasOwn(message, "result"),
            resultReceived: Object.hasOwn(message, "result"),
            errorCode: message.error?.code ?? null,
            scope,
          });
        } else if (request.method === "turn/start") {
          request.record.response = {
            ok: !message.error,
            resultReceived: Object.hasOwn(message, "result"),
            errorCode: message.error?.code ?? null,
          };
        }
      }
    });
  });
  return evidence;
}

async function captureSentinelTextSegments(page, sentinel) {
  const prefix = "ordered-message-segment-text-";
  const renderedSegments = await page
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll((elements) =>
      elements
        .map((element) => ({
          testId: element.getAttribute("data-testid") ?? "",
          text: element.innerText ?? element.textContent ?? "",
        })),
    );
  return renderedSegments.filter(({ text }) => text.includes(sentinel)).map(({ testId, text }) => {
    const encodedBlockId = testId.startsWith(prefix)
      ? testId.slice(prefix.length)
      : "";
    let blockId = encodedBlockId;
    try {
      blockId = decodeURIComponent(encodedBlockId);
    } catch {
      // Preserve the raw test ID suffix if it is not URI encoded.
    }
    const messageItemId = blockId.replace(/:segment:\d+$/, "");
    return {
      testId,
      candidateMessageItemId: messageItemId,
      textLength: text.length,
      textSha256: sha256(text),
      sentinelOffset: text.indexOf(sentinel),
    };
  });
}

function correlateSentinelSegments(segments, assistantItemEvents) {
  return segments.map((segment) => ({
    testId: segment.testId,
    candidateMessageItemId: segment.candidateMessageItemId,
    matchingServerEvents: assistantItemEvents.filter(
      (event) => event.agentMessageId === segment.candidateMessageItemId,
    ),
  }));
}

function parseJsonMessages(payload) {
  try {
    const source = typeof payload === "string"
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : String(payload);
    const decoded = JSON.parse(source);
    return Array.isArray(decoded) ? decoded : [decoded];
  } catch {
    return [];
  }
}

function createMixedToolsResponse(prompt) {
  const lines = [
    "Mixed tool calls completed: read / grep / TodoWrite / bash / edit all used the real tool path.",
    "This scenario verifies default collapsing of consecutive tool calls and ensures an edit diff does not expand the committed area while collapsed.",
    "",
    "```text",
    ...Array.from({ length: 120 }, (_, index) => `tui-lab-final-line-${String(index + 1).padStart(3, "0")}`),
    "```",
    "",
    "tui-lab-mixed-tools-final-sentinel",
    "tui-lab-final-sentinel",
    `Complete: the mixed-tool collapsing scenario returned its final response. User input preview: ${prompt}`,
  ];
  return lines.join("\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
